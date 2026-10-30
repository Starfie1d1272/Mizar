//! Durable, per-process System/Stop reservation. No connection data or unload inference.
use crate::{cs2_session, startup_log::DesktopLog};
use serde_json::{json, Value};
use std::{fs, io::Write, path::PathBuf};

#[repr(C)]
struct ModuleEntry {
    size: u32,
    module_id: u32,
    process_id: u32,
    global_usage: u32,
    process_usage: u32,
    base: *mut u8,
    base_size: u32,
    module: isize,
    name: [u16; 256],
    path: [u16; 260],
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> isize;
    fn WaitForSingleObject(handle: isize, timeout: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
    fn Module32FirstW(snapshot: isize, entry: *mut ModuleEntry) -> i32;
    fn Module32NextW(snapshot: isize, entry: *mut ModuleEntry) -> i32;
    fn GetLastError() -> u32;
}
struct Handle(isize);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Open before submission and hold the event through this injection's stop.
pub struct UnloadProof(Handle);
impl UnloadProof {
    pub fn open(pid: u32) -> Result<Self, String> {
        let name: Vec<u16> = format!("Local\\MulNX_CS2_UnloadReady_{pid}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle = unsafe { OpenEventW(0x00100000, 0, name.as_ptr()) };
        if handle == 0 {
            return Err("无法打开 MulNX 卸载确认事件，未发送停止命令。".into());
        }
        let proof = Self(Handle(handle));
        if unsafe { WaitForSingleObject(handle, 0) } != 258 {
            return Err("MulNX 卸载事件状态不可用，未发送停止命令。".into());
        }
        Ok(proof)
    }
    pub fn confirm(&self, game: &crate::managed_cs2::WorkspaceProcess) -> Result<(), String> {
        if unsafe { WaitForSingleObject(self.0 .0, 10000) } != 0 {
            return Err("MulNX 卸载完成未确认，请保留游戏并检查后重试。".into());
        }
        verify_absent(game)
    }
}

fn module_present(game: &crate::managed_cs2::WorkspaceProcess) -> Result<bool, String> {
    if !game.is_running() {
        return Err("游戏已退出，MulNX 状态无法单独确认。".into());
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(0x18, game.pid) };
    if snapshot == -1 {
        return Err("无法检查 MulNX 模块，状态未知。".into());
    }
    let snapshot = Handle(snapshot);
    let mut entry: ModuleEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ModuleEntry>() as u32;
    let mut next = unsafe { Module32FirstW(snapshot.0, &mut entry) };
    let mut found = false;
    while next != 0 {
        let length = entry
            .name
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.name.len());
        if String::from_utf16_lossy(&entry.name[..length]).eq_ignore_ascii_case("CS2OBTool.dll") {
            found = true;
        }
        next = unsafe { Module32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != 18 {
        return Err("无法完整检查 MulNX 模块，状态未知。".into());
    }
    if !game.is_running() {
        return Err("游戏身份已失效，MulNX 状态未知。".into());
    }
    Ok(found)
}

/// A live gateway and loaded module establish the current injection before
/// opening its event; the event name alone does not identify an injection cycle.
pub fn verify_present(game: &crate::managed_cs2::WorkspaceProcess) -> Result<(), String> {
    if !module_present(game)? {
        return Err("当前游戏没有已启动的 MulNX 模块，未发送停止命令。".into());
    }
    Ok(())
}

/// Recheck the same live process on every retry, including after a restart.
pub fn verify_absent(game: &crate::managed_cs2::WorkspaceProcess) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if !module_present(game)? {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("MulNX 模块仍在游戏中，卸载结果未知。".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[derive(Clone)]
pub struct Identity {
    pub pid: u32,
    pub created: u64,
    pub executable: PathBuf,
}

fn path(log: &DesktopLog, game: &Identity) -> PathBuf {
    log.state_root
        .join("data/mulnx-stop")
        .join(format!("{}-{}.json", game.pid, game.created))
}

pub fn blocked(log: &DesktopLog, game: &Identity) -> Result<bool, String> {
    let path = path(log, game);
    let metadata = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(cs2_session::io_error(
                "停止控制记录无法读取；不要重复发送，请导出诊断。",
                &error,
            ))
        }
        Ok(value) => value,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("停止控制记录不完整；不要重复发送，请导出诊断。".into());
    }
    let bytes = fs::read(&path).map_err(|error| {
        cs2_session::io_error("停止控制记录无法读取；不要重复发送，请导出诊断。", &error)
    })?;
    let record: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "停止控制记录不完整；不要重复发送，请导出诊断。")?;
    if record["version"] != 1
        || !["possibly-sent", "confirmed"].contains(&record["phase"].as_str().unwrap_or(""))
        || record["pid"].as_u64() != Some(game.pid as u64)
        || record["created"].as_u64() != Some(game.created)
        || !record["executable"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(&game.executable.to_string_lossy()))
    {
        return Err("停止控制记录与游戏身份不一致；不要重复发送，请导出诊断。".into());
    }
    Ok(true)
}

/// A confirmed record is useful only while the exact game identity still matches.
pub fn confirmed(log: &DesktopLog, game: &Identity) -> Result<bool, String> {
    if !blocked(log, game)? {
        return Ok(false);
    }
    let bytes = fs::read(path(log, game))
        .map_err(|e| cs2_session::io_error("停止控制记录无法读取。", &e))?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "停止控制记录不完整。")?;
    Ok(record["phase"] == "confirmed")
}
pub fn mark_confirmed(log: &DesktopLog, game: &Identity) -> Result<(), String> {
    if !blocked(log, game)? {
        return Err("停止控制记录缺失。".into());
    }
    let record = json!({"version":1,"phase":"confirmed", "pid":game.pid,
        "created":game.created,"executable":game.executable});
    let bytes = serde_json::to_vec(&record).map_err(|_| "卸载确认记录无法保存。")?;
    cs2_session::atomic_write(&path(log, game), &bytes)
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
        "created":game.created,"executable":game.executable}))
    .map_err(|_| "停止控制记录未保存，未发送命令。")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            cs2_session::io_error(
                "停止控制记录未保存，未发送命令；已有记录时不要重复操作。",
                &error,
            )
        })?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            cs2_session::io_error(
                "停止控制记录未完整保存，未发送命令；不要重复操作，请导出诊断。",
                &error,
            )
        })?;
    drop(file);
    if fs::read(&path)
        .map_err(|error| cs2_session::io_error("停止控制记录未读回，未发送命令。", &error))?
        != bytes
    {
        return Err("停止控制记录读回不一致，未发送命令；不要重复操作，请导出诊断。".into());
    }
    Ok(())
}

/// All preparation, including identity/HUD/gateway checks, must finish before reservation.
pub fn submit<T>(
    log: &DesktopLog,
    game: &Identity,
    prepare: impl FnOnce() -> Result<T, String>,
    send: impl FnOnce(T) -> Result<Value, String>,
) -> Result<Value, String> {
    if blocked(log, game)? {
        return Ok(uncertain("already-submitted"));
    }
    let prepared = prepare()?;
    reserve(log, game)?;
    log.event(
        "mulnx_stop_reserved",
        "possibly-sent",
        Some(&format!("pid={} created={}", game.pid, game.created)),
    );
    match send(prepared) {
        Ok(mut value) if value.is_object() => {
            value["stopGuard"] = "possibly-sent".into();
            Ok(value)
        }
        Ok(_) => {
            log.event("mulnx_stop_send", "unknown", Some("invalid_result"));
            Ok(uncertain("possibly-sent"))
        }
        Err(error) => {
            log.event("mulnx_stop_send", "unknown", Some(&error));
            Ok(uncertain("possibly-sent"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn fixture(run: impl FnOnce(&DesktopLog, &Identity)) {
        let root = std::env::temp_dir().join(format!(
            "mizar-stop-fence-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let log = DesktopLog::new(&root, None).unwrap();
        let game = Identity {
            pid: 42,
            created: 134000000000000000,
            executable: PathBuf::from(r"D:\Steam\cs2.exe"),
        };
        run(&log, &game);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn queued_unknown_and_transport_failure_are_one_shot_across_remount_reborrow_and_restart() {
        for result in [
            Ok(json!({"result":"queued"})),
            Ok(json!({"result":"unknown"})),
            Err("lost acknowledgement".into()),
        ] {
            fixture(|log, game| {
                let calls = Cell::new(0);
                let first = submit(
                    log,
                    game,
                    || Ok(()),
                    |()| {
                        calls.set(calls.get() + 1);
                        result
                    },
                )
                .unwrap();
                assert_eq!(first["stopGuard"], "possibly-sent");
                for _ in 0..2 {
                    // New UI or borrowed handle has no authority to clear the disk record.
                    assert_eq!(
                        submit(
                            log,
                            game,
                            || panic!("repeat preparation"),
                            |()| panic!("repeat send")
                        )
                        .unwrap()["stopGuard"],
                        "already-submitted"
                    );
                }
                let restarted =
                    DesktopLog::new(&log.state_root, Some(log.state_root.clone())).unwrap();
                assert_eq!(
                    submit(&restarted, game, || Ok(()), |()| panic!("restart send")).unwrap()
                        ["stopGuard"],
                    "already-submitted"
                );
                assert_eq!(calls.get(), 1);
                for (pid, created) in [(game.pid, game.created + 1), (game.pid + 1, game.created)] {
                    let next = Identity {
                        pid,
                        created,
                        executable: game.executable.clone(),
                    };
                    submit(
                        &restarted,
                        &next,
                        || Ok(()),
                        |()| {
                            calls.set(calls.get() + 1);
                            Ok(json!({"result":"queued"}))
                        },
                    )
                    .unwrap();
                }
                assert_eq!(calls.get(), 3);
                assert!(blocked(&restarted, game).unwrap()); // A new instance never removes the old reservation.
            });
        }
    }
    #[test]
    fn confirmation_is_persisted_for_the_same_process_and_never_rearms_stop() {
        fixture(|log, game| {
            reserve(log, game).unwrap();
            assert!(!confirmed(log, game).unwrap());
            mark_confirmed(log, game).unwrap();
            assert!(confirmed(log, game).unwrap());
            assert!(blocked(log, game).unwrap());
            let wrong = Identity {
                executable: PathBuf::from(r"C:\other\cs2.exe"),
                ..game.clone()
            };
            assert!(confirmed(log, &wrong).is_err());
            assert_eq!(
                submit(
                    log,
                    game,
                    || panic!("already confirmed"),
                    |()| panic!("duplicate stop")
                )
                .unwrap()["stopGuard"],
                "already-submitted"
            );
        });
    }
    #[test]
    fn preflight_and_storage_failures_do_not_send() {
        fixture(|log, game| {
            for stage in ["identity", "hud", "gateway"] {
                assert!(submit(
                    log,
                    game,
                    || Err::<(), _>(stage.into()),
                    |()| panic!("send after preflight failure")
                )
                .is_err());
                assert!(!path(log, game).exists());
            }
            let parent = path(log, game).parent().unwrap().to_path_buf();
            fs::create_dir_all(parent.parent().unwrap()).unwrap();
            fs::write(parent, b"not a directory").unwrap();
            assert!(submit(
                log,
                game,
                || Ok(()),
                |()| panic!("send after storage failure")
            )
            .is_err());
        });
    }
    #[test]
    fn failed_reservation_after_successful_preparation_never_sends() {
        fixture(|log, game| {
            let prepared = Cell::new(false);
            assert!(submit(
                log,
                game,
                || {
                    prepared.set(true);
                    fs::create_dir_all(path(log, game)).unwrap(); // Final reservation cannot be written.
                    Ok(())
                },
                |()| panic!("send without reservation")
            )
            .is_err());
            assert!(prepared.get());
        });
    }
    #[test]
    fn concurrent_reservations_have_exactly_one_winner() {
        fixture(|log, game| {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let log = log.clone();
                    let game = game.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        reserve(&log, &game).is_ok()
                    })
                })
                .collect();
            assert_eq!(
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap() as usize)
                    .sum::<usize>(),
                1
            );
            assert!(blocked(log, game).unwrap());
        });
    }
    #[test]
    fn incomplete_or_wrong_identity_record_fails_closed_and_reservation_is_exclusive() {
        fixture(|log, game| {
            reserve(log, game).unwrap();
            assert!(reserve(log, game).is_err());
            let different = Identity {
                executable: PathBuf::from(r"C:\other\cs2.exe"),
                ..game.clone()
            };
            assert!(blocked(log, &different).is_err());
            fs::write(path(log, game), b"{").unwrap();
            assert!(submit(
                log,
                game,
                || Ok(()),
                |()| panic!("send after damaged journal")
            )
            .is_err());
        });
    }
}
