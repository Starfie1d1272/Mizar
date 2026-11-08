//! One bounded, process-scoped fps_max transaction. Uncertain writes are never replayed.
use crate::{cs2_console, cs2_session, managed_cs2, startup_log::DesktopLog};
use serde_json::{json, Value};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};
static TRANSACTION: Mutex<()> = Mutex::new(());

fn file(log: &DesktopLog) -> PathBuf {
    log.state_root.join("data/frame-rate-live.json")
}
fn load(log: &DesktopLog) -> Result<Option<Value>, String> {
    let bytes = match fs::read(file(log)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if bytes.len() > 4096 {
        return Err("帧率恢复记录过大，请保留记录并检查。".into());
    }
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "帧率恢复记录无法读取。")?;
    if record["version"] != 1
        || !record["pid"]
            .as_u64()
            .is_some_and(|v| v > 0 && v <= u32::MAX as u64)
        || !record["created"].as_u64().is_some_and(|v| v > 0)
        || !record["executable"]
            .as_str()
            .is_some_and(|v| Path::new(v).is_absolute())
        || ![
            "apply_pending",
            "applied",
            "restore_pending",
            "restored",
            "relinquished",
            "ended",
        ]
        .contains(&record["phase"].as_str().unwrap_or(""))
        || ["original", "applied"].iter().any(|key| {
            !record[*key]
                .as_f64()
                .is_some_and(|v| v.is_finite() && (0.0..=10000.0).contains(&v))
        })
        || !matches!(record["applied"].as_f64(), Some(30.0 | 60.0))
        || (record["phase"] == "restore_pending" && record.get("restoreAttemptId").is_none())
        || !record["attemptId"].as_str().is_some_and(valid_marker)
        || (record.get("restoreAttemptId").is_some()
            && !record["restoreAttemptId"]
                .as_str()
                .is_some_and(valid_marker))
    {
        return Err("帧率恢复记录无效，请保留原件并检查。".into());
    }
    Ok(Some(record))
}
fn valid_marker(value: &str) -> bool {
    value.strip_prefix("MIZAR_FPS_").is_some_and(|v| {
        v.len() == 32
            && v.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn active(record: &Value) -> bool {
    matches!(
        record["phase"].as_str(),
        Some("apply_pending" | "applied" | "restore_pending")
    )
}
pub(crate) fn pending(log: &DesktopLog) -> bool {
    load(log).map_or(true, |v| v.as_ref().is_some_and(active))
}
fn save(log: &DesktopLog, record: &Value) -> Result<(), String> {
    fs::create_dir_all(log.state_root.join("data")).map_err(|e| e.to_string())?;
    cs2_session::atomic_write(
        &file(log),
        &serde_json::to_vec(record).map_err(|e| e.to_string())?,
    )?;
    let marker = record["restoreAttemptId"]
        .as_str()
        .or_else(|| record["attemptId"].as_str())
        .unwrap();
    let attempt = frame_rate_attempt_id(marker);
    log.with_attempt(Some(&attempt), || log.event("cs2_frame_rate_transaction", record["phase"].as_str().unwrap_or("unknown"),
        Some(&json!({"attemptId":record["attemptId"],"restoreAttemptId":record["restoreAttemptId"],"original":record["original"],"applied":record["applied"],"pid":record["pid"],"created":record["created"]}).to_string())));
    Ok(())
}
pub(crate) fn retire_ended(log: &DesktopLog) -> Result<(), String> {
    let _guard = TRANSACTION.lock().map_err(|_| "帧率恢复记录正忙。")?;
    if let Some(mut record) = load(log)? {
        if active(&record) && managed_cs2::verified_session_process(&record, log)?.is_none() {
            record["phase"] = "ended".into();
            save(log, &record)?;
        }
    }
    Ok(())
}
fn answer(
    status: &str,
    current: Option<f64>,
    phase: &str,
    can_apply: bool,
    can_restore: bool,
    message: &str,
) -> Value {
    json!({"status":status,"current":current,"transaction":phase,"canApply":can_apply,"canRestore":can_restore,"message":message})
}
fn unknown(message: &str) -> Value {
    answer("unconfirmed", None, "pending", false, false, message)
}

/// Shutdown may first resolve a prior apply receipt. Only a positively confirmed,
/// still-owned apply permits a separate restore operation with fresh preflight.
/// This never retries an uncertain write and is not used by interactive inspection.
pub(crate) fn finish_restore(
    mut restore: impl FnMut() -> Result<Value, String>,
) -> Result<Value, String> {
    let result = restore()?;
    if result["status"] == "confirmed"
        && result["transaction"] == "applied"
        && result["canRestore"] == true
    {
        restore()
    } else {
        Ok(result)
    }
}

pub(crate) fn control(
    log: &DesktopLog,
    executable: &Path,
    process: &managed_cs2::WorkspaceProcess,
    action: &str,
    target: Option<u16>,
    mut valid: impl FnMut() -> bool,
) -> Result<Value, String> {
    let _guard = TRANSACTION.lock().map_err(|_| "帧率恢复记录正忙。")?;
    if !matches!(action, "inspect" | "apply" | "restore")
        || (action == "apply" && !matches!(target, Some(30 | 60)))
    {
        return Err("现场帧率仅支持读取、30/60帧应用及恢复。".into());
    }
    let mut record = load(log)?;
    if record.as_ref().is_some_and(active)
        && record
            .as_ref()
            .is_some_and(|r| r["pid"] != process.pid || r["created"] != process.created)
    {
        return Ok(unknown("此前游戏实例的帧率记录仍待核对，本次未写入。"));
    }
    if !valid() {
        return Ok(unknown("受管游戏身份或控制权限已变化，本次未写入。"));
    }
    let current = match probe_frame_rate(log, executable) {
        Ok(current) if valid() => current,
        Ok(_) => return Ok(unknown("游戏实例已变化，本次读回未确认。")),
        Err(error) => return Ok(unknown(&error)),
    };
    if let Some(saved) = record.as_mut().filter(|r| active(r)) {
        let phase = saved["phase"].as_str().unwrap().to_string();
        let wanted = if phase == "restore_pending" {
            saved["original"].as_f64().unwrap()
        } else {
            saved["applied"].as_f64().unwrap()
        };
        if phase.ends_with("_pending") {
            let marker_key = if phase == "restore_pending" {
                "restoreAttemptId"
            } else {
                "attemptId"
            };
            let marker = saved[marker_key].as_str().unwrap();
            let attempt = frame_rate_attempt_id(marker);
            let receipt = log.with_attempt(Some(&attempt), || {
                let result = frame_rate_receipt(executable, marker);
                log.native_outcome("fps_max_original_receipt_recheck", None, &result);
                result
            })?;
            if receipt != Some(wanted) || !valid() {
                return Ok(unknown(
                    "原写入回执尚未确认。只能复查，不会重复应用或恢复；可在游戏原生设置核对。",
                ));
            }
            saved["phase"] = if phase == "restore_pending" {
                "restored"
            } else {
                "applied"
            }
            .into();
            save(log, saved)?;
        }
        if saved["phase"] == "applied" && current != saved["applied"].as_f64().unwrap() {
            saved["phase"] = "relinquished".into();
            save(log, saved)?;
            return Ok(answer(
                "confirmed",
                Some(current),
                "relinquished",
                true,
                false,
                "检测到游戏内后续修改，已让出控制，不覆盖当前值。",
            ));
        }
        if saved["phase"] == "restored" {
            return Ok(answer(
                "confirmed",
                Some(current),
                "restored",
                true,
                false,
                "原恢复命令已读回确认；当前值以本次读取为准。",
            ));
        }
        if action != "restore" || phase.ends_with("_pending") {
            return Ok(answer(
                "confirmed",
                Some(current),
                "applied",
                false,
                true,
                "本次帧率已执行并读回确认。再次调整前先恢复本次原值。",
            ));
        }
        // Recheck ownership immediately before reserving restoration. The
        // console has no compare-and-swap; do not overwrite an observed manual change.
        let latest = match probe_frame_rate(log, executable) {
            Ok(value) if valid() => value,
            result => {
                log.native_outcome("fps_max_restore_preflight", None, &result);
                return Ok(unknown("恢复前当前值尚未确认，未发出恢复命令。"));
            }
        };
        if latest != saved["applied"].as_f64().unwrap() {
            saved["phase"] = "relinquished".into();
            save(log, saved)?;
            return Ok(answer(
                "confirmed",
                Some(latest),
                "relinquished",
                true,
                false,
                "检测到游戏内后续修改，未覆盖当前值。",
            ));
        }
        let marker = frame_rate_marker()?;
        saved["restoreAttemptId"] = marker.clone().into();
        saved["phase"] = "restore_pending".into();
        save(log, saved)?;
        if !valid() {
            return Ok(unknown("恢复前实例已变化，未继续写入；请复查。"));
        }
        let original = saved["original"].as_f64().unwrap();
        let result = frame_rate_command(log, executable, &marker, Some(original));
        if !valid() || result.as_ref().ok().copied() != Some(original) {
            log.event("fps_max_restore", "unconfirmed", Some(&json!({"attemptId":saved["restoreAttemptId"],"expected":original,"readback":format!("{result:?}")}).to_string()));
            return Ok(unknown("恢复结果尚未确认。请复查，不会重复写入。"));
        }
        saved["phase"] = "restored".into();
        save(log, saved)?;
        return Ok(answer(
            "confirmed",
            Some(original),
            "restored",
            true,
            false,
            "本次原值已恢复并读回确认。",
        ));
    }
    if action != "apply" {
        return Ok(answer(
            "confirmed",
            Some(current),
            "idle",
            true,
            false,
            "已读回当前帧率上限，可选择30或60帧进行本次调整。",
        ));
    }
    let target = f64::from(target.unwrap());
    if current == target {
        return Ok(answer(
            "confirmed",
            Some(current),
            "idle",
            true,
            false,
            "当前值已经一致，未写入，也未取得恢复所有权。",
        ));
    }
    let marker = frame_rate_marker()?;
    let mut saved = json!({"version":1,"pid":process.pid,"created":process.created,"executable":executable,
        "original":current,"applied":target,"attemptId":marker,"phase":"apply_pending"});
    save(log, &saved)?;
    if !valid() {
        return Ok(unknown("应用前实例已变化，未继续写入；请复查。"));
    }
    let result = frame_rate_command(log, executable, &marker, Some(target));
    if !valid() || result.as_ref().ok().copied() != Some(target) {
        log.event("fps_max_apply", "unconfirmed", Some(&json!({"attemptId":saved["attemptId"],"expected":target,"readback":format!("{result:?}")}).to_string()));
        return Ok(unknown("应用结果尚未确认。请复查，不会重复写入。"));
    }
    saved["phase"] = "applied".into();
    save(log, &saved)?;
    Ok(answer(
        "confirmed",
        Some(target),
        "applied",
        false,
        true,
        "本次帧率已执行并读回确认；退出前仅在值仍属于本次修改时恢复。",
    ))
}

/// A finite read-only probe on the already-consented console.
fn probe_frame_rate(log: &DesktopLog, executable: &Path) -> Result<f64, String> {
    frame_rate_command(log, executable, &frame_rate_marker()?, None)
}

fn frame_rate_marker() -> Result<String, String> {
    Ok(format!(
        "MIZAR_FPS_{:032x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ))
}

/// The caller durably reserves every write attempt before this function.
fn frame_rate_command(
    log: &DesktopLog,
    executable: &Path,
    marker: &str,
    value: Option<f64>,
) -> Result<f64, String> {
    if !valid_marker(marker)
        || value.is_some_and(|v| !v.is_finite() || !(0.0..=10000.0).contains(&v))
    {
        return Err("帧率命令参数无效。".into());
    }
    let attempt = frame_rate_attempt_id(marker);
    log.with_attempt(Some(&attempt), || {
        let result = frame_rate_command_inner(log, executable, marker, value);
        log.native_outcome("fps_max_command_readback", None, &result);
        result
    })
}

fn frame_rate_attempt_id(marker: &str) -> String {
    let hex = marker.strip_prefix("MIZAR_FPS_").unwrap_or(marker);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn frame_rate_command_inner(
    log: &DesktopLog,
    executable: &Path,
    marker: &str,
    value: Option<f64>,
) -> Result<f64, String> {
    let root = crate::host_runtime::bundle_root()?;
    let mut command = Command::new(root.join("resources/runtime/node.exe"));
    command
        .arg(root.join("resources/app/dist/telemetry/observer-game-control.js"))
        .args(["--frame-rate-query", marker])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .creation_flags(0x08000000);
    if let Some(value) = value {
        command.arg(value.to_string());
    }
    crate::powershell::run(command, log, "游戏帧率读回", Duration::from_secs(12))?;
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if let Some(value) = frame_rate_receipt(executable, marker)? {
            return Ok(value);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("尚未收到本次游戏帧率读回；请复查，不会重复写入。".into())
}

/// Re-read the original attempt's unique receipt without replaying its command.
fn frame_rate_receipt(executable: &Path, marker: &str) -> Result<Option<f64>, String> {
    let Some(text) = cs2_console::receipt(executable, marker)? else {
        return Ok(None);
    };
    let value =
        regex::Regex::new(r#"(?im)^\s*"?fps_max"?\s*(?:=|:)\s*"?([0-9]+(?:\.[0-9]+)?)\b"#).unwrap();
    let values: Vec<f64> = value
        .captures_iter(&text)
        .filter_map(|c| c[1].parse().ok())
        .collect();
    if let Some(current) = values
        .first()
        .copied()
        .filter(|v| v.is_finite() && (0.0..=10000.0).contains(v))
    {
        if values.iter().all(|v| *v == current) {
            return Ok(Some(current));
        }
    }
    Err("游戏帧率读回缺失或不一致，本次结果尚未确认。".into())
}
