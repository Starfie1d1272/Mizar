//! Durable, per-process System/Stop reservation. No connection data or unload inference.
use crate::{cs2_session, startup_log::DesktopLog};
use serde_json::{json, Value};
use std::{fs, io::Write, path::PathBuf};

#[derive(Clone)]
pub struct Identity {
    pub pid: u32,
    pub created: u64,
    pub executable: PathBuf,
}

fn path(log: &DesktopLog, game: &Identity) -> PathBuf {
    log.state_root.join("data/mulnx-stop").join(format!("{}-{}.json", game.pid, game.created))
}

pub fn blocked(log: &DesktopLog, game: &Identity) -> Result<bool, String> {
    let path = path(log, game);
    let metadata = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(cs2_session::io_error("停止控制记录无法读取；不要重复发送，请导出诊断。", &error)),
        Ok(value) => value,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("停止控制记录不完整；不要重复发送，请导出诊断。".into());
    }
    let bytes = fs::read(&path).map_err(|error| cs2_session::io_error("停止控制记录无法读取；不要重复发送，请导出诊断。", &error))?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "停止控制记录不完整；不要重复发送，请导出诊断。")?;
    if record["version"] != 1 || record["phase"] != "possibly-sent"
        || record["pid"].as_u64() != Some(game.pid as u64) || record["created"].as_u64() != Some(game.created)
        || !record["executable"].as_str().is_some_and(|value| value.eq_ignore_ascii_case(&game.executable.to_string_lossy())) {
        return Err("停止控制记录与游戏身份不一致；不要重复发送，请导出诊断。".into());
    }
    Ok(true)
}

pub fn uncertain(guard: &str) -> Value {
    json!({"result":"unknown","execution":"unconfirmed","stopGuard":guard})
}

/// create_new atomically reserves this instance, including across Host processes.
/// A crash/failed write leaves a fail-closed reservation. Send is allowed only after sync and readback.
fn reserve(log: &DesktopLog, game: &Identity) -> Result<(), String> {
    let path = path(log, game);
    fs::create_dir_all(path.parent().ok_or("停止控制记录目录无效。")?)
        .map_err(|error| cs2_session::io_error("停止控制记录未保存，未发送命令。", &error))?;
    let bytes = serde_json::to_vec(&json!({"version":1,"phase":"possibly-sent", "pid":game.pid,
        "created":game.created,"executable":game.executable})).map_err(|_| "停止控制记录未保存，未发送命令。")?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|error| cs2_session::io_error("停止控制记录未保存，未发送命令；已有记录时不要重复操作。", &error))?;
    file.write_all(&bytes).and_then(|()| file.sync_all())
        .map_err(|error| cs2_session::io_error("停止控制记录未完整保存，未发送命令；不要重复操作，请导出诊断。", &error))?;
    drop(file);
    if fs::read(&path).map_err(|error| cs2_session::io_error("停止控制记录未读回，未发送命令。", &error))? != bytes {
        return Err("停止控制记录读回不一致，未发送命令；不要重复操作，请导出诊断。".into());
    }
    Ok(())
}

/// All preparation, including identity/HUD/gateway checks, must finish before reservation.
pub fn submit<T>(log: &DesktopLog, game: &Identity,
    prepare: impl FnOnce() -> Result<T, String>, send: impl FnOnce(T) -> Result<Value, String>) -> Result<Value, String> {
    if blocked(log, game)? { return Ok(uncertain("already-submitted")); }
    let prepared = prepare()?;
    reserve(log, game)?;
    log.event("mulnx_stop_reserved", "possibly-sent", Some(&format!("pid={} created={}", game.pid, game.created)));
    match send(prepared) {
        Ok(mut value) if value.is_object() => { value["stopGuard"] = "possibly-sent".into(); Ok(value) },
        Ok(_) => { log.event("mulnx_stop_send", "unknown", Some("invalid_result")); Ok(uncertain("possibly-sent")) },
        Err(error) => {
            log.event("mulnx_stop_send", "unknown", Some(&error));
            Ok(uncertain("possibly-sent"))
        }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    use std::cell::Cell;
    fn fixture(run: impl FnOnce(&DesktopLog, &Identity)) {
        let root = std::env::temp_dir().join(format!("mizar-stop-fence-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let log = DesktopLog::new(&root, None).unwrap();
        let game = Identity { pid:42, created:134000000000000000, executable:PathBuf::from(r"D:\Steam\cs2.exe") };
        run(&log, &game);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn queued_unknown_and_transport_failure_are_one_shot_across_remount_reborrow_and_restart() {
        for result in [Ok(json!({"result":"queued"})), Ok(json!({"result":"unknown"})), Err("lost acknowledgement".into())] {
            fixture(|log, game| {
                let calls = Cell::new(0);
                let first = submit(log, game, || Ok(()), |()| { calls.set(calls.get()+1); result }).unwrap();
                assert_eq!(first["stopGuard"], "possibly-sent");
                for _ in 0..2 { // New UI or borrowed handle has no authority to clear the disk record.
                    assert_eq!(submit(log, game, || panic!("repeat preparation"), |()| panic!("repeat send")).unwrap()["stopGuard"], "already-submitted");
                }
                let restarted = DesktopLog::new(&log.state_root, None).unwrap();
                assert_eq!(submit(&restarted, game, || Ok(()), |()| panic!("restart send")).unwrap()["stopGuard"], "already-submitted");
                assert_eq!(calls.get(), 1);
                for (pid, created) in [(game.pid, game.created+1), (game.pid+1, game.created)] {
                    let next = Identity { pid, created, executable:game.executable.clone() };
                    submit(&restarted, &next, || Ok(()), |()| { calls.set(calls.get()+1); Ok(json!({"result":"queued"})) }).unwrap();
                }
                assert_eq!(calls.get(), 3);
                assert!(blocked(&restarted, game).unwrap()); // A new instance never removes the old reservation.
            });
        }
    }
    #[test] fn preflight_and_storage_failures_do_not_send() {
        fixture(|log, game| {
            for stage in ["identity", "hud", "gateway"] {
                assert!(submit(log, game, || Err::<(), _>(stage.into()), |()| panic!("send after preflight failure")).is_err());
                assert!(!path(log, game).exists());
            }
            let parent = path(log, game).parent().unwrap().to_path_buf();
            fs::create_dir_all(parent.parent().unwrap()).unwrap();
            fs::write(parent, b"not a directory").unwrap();
            assert!(submit(log, game, || Ok(()), |()| panic!("send after storage failure")).is_err());
        });
    }
    #[test] fn failed_reservation_after_successful_preparation_never_sends() {
        fixture(|log, game| {
            let prepared = Cell::new(false);
            assert!(submit(log, game, || {
                prepared.set(true);
                fs::create_dir_all(path(log, game)).unwrap(); // Final reservation cannot be written.
                Ok(())
            }, |()| panic!("send without reservation")).is_err());
            assert!(prepared.get());
        });
    }
    #[test] fn concurrent_reservations_have_exactly_one_winner() {
        fixture(|log, game| {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handles: Vec<_> = (0..2).map(|_| {
                let log = log.clone(); let game = game.clone(); let barrier = barrier.clone();
                std::thread::spawn(move || { barrier.wait(); reserve(&log, &game).is_ok() })
            }).collect();
            assert_eq!(handles.into_iter().map(|handle| handle.join().unwrap() as usize).sum::<usize>(), 1);
            assert!(blocked(log, game).unwrap());
        });
    }
    #[test] fn incomplete_or_wrong_identity_record_fails_closed_and_reservation_is_exclusive() {
        fixture(|log, game| {
            reserve(log, game).unwrap();
            assert!(reserve(log, game).is_err());
            let different = Identity { executable:PathBuf::from(r"C:\other\cs2.exe"), ..game.clone() };
            assert!(blocked(log, &different).is_err());
            fs::write(path(log, game), b"{").unwrap();
            assert!(submit(log, game, || Ok(()), |()| panic!("send after damaged journal")).is_err());
        });
    }
}
