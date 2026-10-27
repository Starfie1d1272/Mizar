//! The native host selects the installation and opens the managed upstream launcher.
use crate::{cs2_activity, gsi_script, managed_cs2, powershell, production_exit, startup_log::DesktopLog, updates};
use std::{path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}, process::Command};
use std::os::windows::process::CommandExt;
use serde_json::{Value, json};
use tauri::Manager;
use crate::ShellExecuteW;
static LAUNCH_GATE: Mutex<()> = Mutex::new(());

pub fn launch(app: &tauri::AppHandle, log: &DesktopLog, automatic: bool) -> Result<Value, String> {
    launch_operation(app, log, automatic, false)
}

pub fn update(app: &tauri::AppHandle, log: &DesktopLog) -> Result<Value, String> {
    launch_operation(app, log, false, true)
}

fn launch_operation(app: &tauri::AppHandle, log: &DesktopLog, automatic: bool, update_only: bool) -> Result<Value, String> {
    let _launch = LAUNCH_GATE.try_lock().map_err(|_| "MulNX 正在启动，请等待本次操作完成。")?;
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
    let no_game = || -> Result<(), String> {
        let cs2 = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?;
        let status = cs2.mulnx_handoff_status()?;
        if !status["processes"].as_array().is_some_and(|processes| processes.is_empty()) {
            return Err("请先退出 CS2，再通过 MulNX 启动。".into());
        }
        Ok(())
    };
    if !automatic { no_game()?; }
    let status = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.status()?;
    if status["pending"] == true || status["demoCleanupPending"] == true || (!automatic && status["spectatorRecoveryPending"] == true) {
        return Err("请先完成原有 CS2 配置恢复，再通过 MulNX 启动。".into());
    }
    let activity = app.state::<cs2_activity::Activity>();
    let _activity = activity.begin(3);
    let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), log)?;
    let gsi = powershell::parse(log, "MulNX 游戏安装位置", &output)?;
    if gsi["detected"] != true || gsi["installed"] != true || gsi["conflict"] != false || gsi["readFailed"] != false {
        return Err("请先完成 CS2 的 GSI 配置。".into());
    }
    let cfg = PathBuf::from(gsi["cfgPath"].as_str().ok_or("CS2 安装位置未确认。")?);
    let executable = cfg.parent().and_then(Path::parent).and_then(Path::parent)
        .ok_or("CS2 安装位置无效。")?.join("bin").join("win64").join("cs2.exe");
    if !executable.is_file() { return Err("所选 CS2 程序不存在。".into()); }
    let results = log.state_root.join("data/mulnx-launch");
    if automatic {
        let actual = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_handoff_status()?;
        if actual["processes"].as_array().is_some_and(|processes| !processes.is_empty()) {
            let receipt = std::fs::read(results.join("current.json")).ok()
                .and_then(|bytes| parse_launch_result(&bytes, true).ok());
            if let Some(receipt) = receipt {
                if validate_game_identity(&actual, &receipt, &executable).is_ok() {
                    let pid = receipt["pid"].as_u64().ok_or("MulNX 游戏身份缺失。")? as u32;
                    let created = receipt["created"].as_str().and_then(|s| s.parse::<u64>().ok()).ok_or("MulNX 游戏创建时间缺失。")?;
                    let matched = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_observer_receipt_matches(pid, created, &executable)?;
                    validate_observer_reuse(status["spectatorRecoveryPending"] == true, matched, || {
                        cleanup_then_mark(
                            || production_exit::prepare_mulnx(log, &executable, false, false).map(|_| ()),
                            || managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。".to_string())?.mark_observer_mulnx_options_clean(),
                        )
                    })?;
                    log.event("mulnx_launch_reuse", "success", Some(&receipt.to_string()));
                    return Ok(receipt);
                }
            }
            return Err("已有 CS2 与本次 MulNX 启动记录不匹配，请先退出它，或从外部游戏交接入口明确选择。".into());
        }
    }
    if status["spectatorRecoveryPending"] == true { return Err("请先完成上次游戏配置恢复。".into()); }
    no_game()?;
    let prepared = production_exit::prepare_mulnx(log, &executable, update_only, false)?;
    if update_only { no_game()?; return Ok(prepared); }
    let launcher = PathBuf::from(prepared["launcher"].as_str().ok_or("MulNX 启动路径缺失。")?);
    let root = log.state_root.join("data/mulnx").canonicalize().map_err(|e| format!("MulNX 目录无法读取：{e}"))?;
    let launcher = launcher.canonicalize().map_err(|e| format!("MulNX 程序无法读取：{e}"))?;
    if !launcher.starts_with(&root) || launcher.file_name().and_then(|s| s.to_str()) != Some("CS2Injector.exe") {
        return Err("MulNX 启动路径无效。".into());
    }
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    no_game()?;
    if let Err(reason) = validate_launch_capability(automatic, &prepared) {
        log.event("mulnx_launch", "manual-required", Some(&json!({"reason":reason,"version":prepared["version"]}).to_string()));
        return Err(reason);
    }
    if !automatic {
        // Opening the UI grants no game or keyboard ownership and does not add
        // the session-only exec; the user may start a game independently later.
        crate::observer_hud::preflight(log, status["preferMulnx"] == true)?;
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = format!("{}\0", launcher.display()).encode_utf16().collect();
        let directory: Vec<u16> = format!("{}\0", launcher.parent().ok_or("MulNX 目录无效。")?.display()).encode_utf16().collect();
        let result = unsafe { ShellExecuteW(0, verb.as_ptr(), target.as_ptr(), std::ptr::null(), directory.as_ptr(), 1) };
        if result <= 32 { return Err(format!("MulNX 未能打开（系统代码 {result}）。")); }
        log.event("mulnx_launch", "success", Some(&format!("version={}; spectator_cfg=not_requested", prepared["version"])));
        return Ok(Value::Null);
    }
    let spectator_cfg = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.prepare_observer_for_mulnx(&executable)?;
    let cancel_unsubmitted = || -> Result<(), String> {
        managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.cancel_unsubmitted_mulnx_observer()
    };
    let mark_options_clean = || -> Result<(), String> {
        managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mark_observer_mulnx_options_clean()
    };
    let cleanup_options = || -> Result<(), String> {
        cleanup_then_mark(
            || production_exit::prepare_mulnx(log, &executable, false, false).map(|_| ()),
            &mark_options_clean,
        )
    };
    let native_hud = if spectator_cfg {
        match managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。".to_string()).and_then(|cs2| cs2.prepared_native_hud()) {
            Ok(value) => value,
            Err(error) => return finish_observer_attempt(Err(error), mark_options_clean(), false, &cancel_unsubmitted),
        }
    } else { false };
    if !native_hud {
        if let Err(error) = crate::observer_hud::preflight(log, status["preferMulnx"] == true) {
            return if spectator_cfg { finish_observer_attempt(Err(error), mark_options_clean(), false, &cancel_unsubmitted) } else { Err(error) };
        }
    }
    if spectator_cfg {
        let configured = production_exit::prepare_mulnx(log, &executable, false, true);
        match configured {
            Ok(value) if value["launcher"] == prepared["launcher"] && value["version"] == prepared["version"] && value["launchProtocol"] == prepared["launchProtocol"] => (),
            result => {
                let reason = match result { Err(error) => error, Ok(_) => "启动器身份或版本已变化。".into() };
                let cleanup = cleanup_options();
                return finish_observer_attempt(Err(reason), cleanup, false, &cancel_unsubmitted);
            }
        }
    }
    let mut spawned = false;
    let mut confirmed_failure = false;
    let outcome = (|| -> Result<Value, String> {
        // Preserve the prior raw console before giving the launcher control.
        crate::cs2_console::prepare(log, &executable)?;
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        no_game()?;
        if spectator_cfg {
            managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.validate_prepared_mulnx_observer(&executable)?;
        }
        std::fs::create_dir_all(&results).map_err(|error| log.preserve_error("mulnx_launch", None, &error, "无法准备 MulNX 启动记录。"))?;
        let result_path = results.join(format!("{}-{}.json", log.session_id, chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        let mut child = Command::new(&launcher).arg("--launch-result").arg(&result_path)
            .current_dir(launcher.parent().ok_or("MulNX 目录无效。")?)
            .creation_flags(0x08000000).spawn()
            .map_err(|error| log.preserve_error("mulnx_launch", None, &error, "MulNX 未能启动。"))?;
        spawned = true;
        log.event("mulnx_launch", "begin", Some(&json!({"launcherPid":child.id(),"resultPath":result_path,"version":prepared["version"]}).to_string()));
        let deadline = Instant::now() + Duration::from_secs(120);
        let exit = loop {
            if let Some(exit) = child.try_wait().map_err(|error| log.preserve_error("mulnx_launch", None, &error, "MulNX 启动结果无法读取。"))? { break exit; }
            if Instant::now() >= deadline {
                // Do not kill an unconfirmed game or silently replay launch.
                return Err("MulNX 启动超时；请检查游戏与启动记录，确认收尾后再重试。".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let bytes = std::fs::read(&result_path).map_err(|error| log.preserve_error("mulnx_launch", None, &error, "MulNX 未返回启动记录。"))?;
        let result = parse_launch_result(&bytes, exit.success())?;
        log.event("mulnx_launch", if result["ok"] == true { "success" } else { "failure" }, Some(&result.to_string()));
        if result["ok"] != true {
            let reason = if result["cleanupPending"] == true {
                "MulNX 启动未完成，且本次游戏收尾待确认。请在运行诊断中核对进程状态后重试。"
            } else if result["stage"] == "environment" {
                "MulNX 环境检查未通过，请先关闭完美世界竞技平台等第三方游戏平台，再检查运行诊断并重试。"
            } else {
                "MulNX 启动失败，本次游戏已收尾。请在运行诊断中查看原始错误后重试。"
            };
            // Mark completion only after temporary launch options have also
            // been restored; until then recovery must retain the backup.
            confirmed_failure = spectator_cfg && failure_receipt_confirms_cleanup(&result);
            return Err(reason.into());
        }
        validate_game_identity(&managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_handoff_status()?, &result, &executable)?;
        if spectator_cfg {
            let pid = result["pid"].as_u64().ok_or("MulNX 游戏进程身份缺失。")? as u32;
            let created = result["created"].as_str().and_then(|s| s.parse::<u64>().ok()).ok_or("MulNX 游戏创建时间缺失。")?;
            managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.bind_observer_mulnx_process(pid, created, &executable)?;
        }
        let temporary = results.join(format!("current-{}.tmp", log.session_id));
        if let Err(error) = std::fs::write(&temporary, &bytes)
            .and_then(|()| std::fs::rename(&temporary, results.join("current.json"))) {
            log.preserve_error("mulnx_launch_receipt", None, &error, ());
        }
        Ok(result)
    })();
    if spectator_cfg {
        let cleanup = cleanup_options();
        if let Err(error) = &cleanup { log.event("mulnx_launch_options", "failure", Some(error)); }
        if cleanup.is_ok() && confirmed_failure {
            if let Err(error) = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。".to_string())
                .and_then(|cs2| cs2.mark_observer_mulnx_finished()) {
                let reason = outcome.as_ref().err().map(String::as_str).unwrap_or("MulNX 启动失败。");
                return Err(format!("{reason} 启动收尾无法确认：{error}；观战备份仍保留。"));
            }
        }
        return finish_observer_attempt(outcome, cleanup, spawned, &cancel_unsubmitted);
    }
    outcome
}

/// Persist clean only after the launcher configuration is restored.
fn cleanup_then_mark(cleanup: impl FnOnce() -> Result<(), String>, mark: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    cleanup()?;
    mark()
}

/// A backup can be disarmed only before the injector exists and after its
/// launch options are restored. Unknown outcomes retain the recovery record.
fn finish_observer_attempt<T>(
    outcome: Result<T, String>,
    options_cleanup: Result<(), String>,
    spawned: bool,
    cancel: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    if let Err(error) = options_cleanup {
        let prior = outcome.as_ref().err().map(|e| format!("{e} ")).unwrap_or_default();
        return Err(format!("{prior}解说启动参数清理或记录确认失败：{error}；原键位备份仍保留。"));
    }
    if !spawned {
        if let Err(error) = cancel() {
            let prior = outcome.as_ref().err().map(|e| format!("{e} ")).unwrap_or_default();
            return Err(format!("{prior}未启动的观战备份未能清理：{error}；请检查恢复状态。"));
        }
    }
    outcome
}

/// A matched receipt may resume only after temporary launcher options are
/// restored. A conflict keeps the observer record for explicit recovery.
fn validate_observer_reuse(
    recovery_pending: bool,
    record_matches: bool,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if recovery_pending && !record_matches { return Err("请先完成上次游戏配置恢复。".into()); }
    if record_matches {
        cleanup().map_err(|error| format!("解说启动参数清理或记录确认失败：{error}；原键位备份仍保留。"))?;
    }
    Ok(())
}

fn failure_receipt_confirms_cleanup(result: &Value) -> bool {
    result["ok"] == false && result["cleanupPending"] == false
}

fn validate_launch_capability(automatic: bool, prepared: &Value) -> Result<(), String> {
    if automatic && prepared["launchProtocol"] != 1 {
        return Err("mulnx_manual_launch_required".into());
    }
    Ok(())
}

fn parse_launch_result(bytes: &[u8], success: bool) -> Result<Value, String> {
    if bytes.len() > 16 * 1024 { return Err("MulNX 启动记录过大。".into()); }
    let result: Value = serde_json::from_slice(bytes).map_err(|_| "MulNX 启动记录不完整。")?;
    if result["protocol"] != 1 || result["ok"].as_bool() != Some(success)
        || result["stage"].as_str().is_none() || result["cleanupPending"].as_bool().is_none()
        || (success && (result["stage"] != "resumed" || result["cleanupPending"] != false
            || !result["pid"].as_u64().is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64)
            || result["created"].as_str().and_then(|value| value.parse::<u64>().ok()).is_none())) {
        return Err("MulNX 启动结果与实际退出状态不一致。".into());
    }
    Ok(result)
}

fn validate_game_identity(status: &Value, result: &Value, executable: &Path) -> Result<(), String> {
    let processes = status["processes"].as_array().ok_or("CS2 实例状态不可用。")?;
    if processes.len() != 1 || processes[0]["pid"] != result["pid"] || processes[0]["created"] != result["created"]
        || !processes[0]["executable"].as_str().is_some_and(|path| path.eq_ignore_ascii_case(&executable.to_string_lossy())) {
        return Err("MulNX 返回的 CS2 实例与本机实际进程不一致，请检查游戏状态。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_validated_failure_with_completed_cleanup_allows_recovery() {
        let failure = json!({"protocol":1,"ok":false,"stage":"load","cleanupPending":false});
        let parsed = parse_launch_result(failure.to_string().as_bytes(), false).unwrap();
        assert!(failure_receipt_confirms_cleanup(&parsed));
        let pending = json!({"protocol":1,"ok":false,"stage":"load","cleanupPending":true});
        let parsed = parse_launch_result(pending.to_string().as_bytes(), false).unwrap();
        assert!(!failure_receipt_confirms_cleanup(&parsed));
        assert!(parse_launch_result(b"{}", false).is_err());
        let success = json!({"protocol":1,"ok":true,"stage":"resumed","pid":42,"created":"1","cleanupPending":false});
        assert!(!failure_receipt_confirms_cleanup(&parse_launch_result(success.to_string().as_bytes(), true).unwrap()));
    }
    #[test]
    fn options_clean_is_recorded_only_after_successful_cleanup() {
        use std::cell::RefCell;
        let steps = RefCell::new(Vec::new());
        let failure = cleanup_then_mark(|| { steps.borrow_mut().push("cleanup"); Err("cleanup failed".into()) },
            || { steps.borrow_mut().push("mark"); Ok(()) });
        assert!(failure.is_err()); assert_eq!(*steps.borrow(), vec!["cleanup"]);
        steps.borrow_mut().clear();
        let failure = cleanup_then_mark(|| { steps.borrow_mut().push("cleanup"); Ok(()) },
            || { steps.borrow_mut().push("mark"); Err("mark failed".into()) });
        assert!(failure.is_err()); assert_eq!(*steps.borrow(), vec!["cleanup", "mark"]);
        let cancelled = std::cell::Cell::new(false);
        let outcome = finish_observer_attempt::<()>(Err("launch".into()), failure, false, || { cancelled.set(true); Ok(()) });
        assert!(outcome.unwrap_err().contains("备份仍保留")); assert!(!cancelled.get());
    }
    #[test]
    fn receipt_reuse_requires_its_own_record_and_clean_launch_options() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        assert!(validate_observer_reuse(true, false, || { calls.set(calls.get() + 1); Ok(()) }).is_err());
        assert_eq!(calls.get(), 0);
        assert!(validate_observer_reuse(false, false, || { calls.set(calls.get() + 1); Ok(()) }).is_ok());
        assert_eq!(calls.get(), 0);
        assert!(validate_observer_reuse(true, true, || { calls.set(calls.get() + 1); Err("参数冲突".into()) }).unwrap_err().contains("备份仍保留"));
        assert_eq!(calls.get(), 1);
        assert!(validate_observer_reuse(false, true, || { calls.set(calls.get() + 1); Ok(()) }).is_ok());
        assert_eq!(calls.get(), 2);
    }
    #[test]
    fn observer_backup_is_disarmed_only_after_unsubmitted_options_are_restored() {
        use std::cell::Cell;
        let cancelled = Cell::new(0);
        let cancel = || { cancelled.set(cancelled.get() + 1); Ok(()) };
        let error = finish_observer_attempt::<()>(Err("preflight".into()), Ok(()), false, cancel).unwrap_err();
        assert_eq!(error, "preflight"); assert_eq!(cancelled.get(), 1);
        let cancel = || { cancelled.set(cancelled.get() + 1); Ok(()) };
        let error = finish_observer_attempt::<()>(Err("setup".into()), Err("options conflict".into()), false, cancel).unwrap_err();
        assert!(error.contains("setup") && error.contains("options conflict") && error.contains("备份仍保留"));
        assert_eq!(cancelled.get(), 1);
        let cancel = || { cancelled.set(cancelled.get() + 1); Ok(()) };
        let error = finish_observer_attempt::<()>(Err("timeout".into()), Ok(()), true, cancel).unwrap_err();
        assert_eq!(error, "timeout"); assert_eq!(cancelled.get(), 1);
        let error = finish_observer_attempt::<()>(Err("spawn failed".into()), Ok(()), false, || Err("record busy".into())).unwrap_err();
        assert!(error.contains("spawn failed") && error.contains("record busy"));
    }
    #[test]
    fn unsupported_local_or_new_release_requires_checked_manual_launch_without_changing_supported_path() {
        for version in ["Beta16.1", "Beta16.2"] {
            let release = json!({"version":version,"launchProtocol":null});
            assert_eq!(validate_launch_capability(true, &release).unwrap_err(), "mulnx_manual_launch_required");
            assert!(validate_launch_capability(false, &release).is_ok());
        }
        assert!(validate_launch_capability(true, &json!({"launchProtocol":1})).is_ok());
        assert!(validate_launch_capability(true, &json!({})).is_err());
    }
    #[test]
    fn gateway_owner_requires_the_actual_listener_process() {
        let root = std::env::temp_dir().join(format!("mizar-gateway-owner-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let log = DesktopLog::new(&root, None).unwrap();
        let unmanaged = managed_cs2::ManagedCs2::new(log.clone());
        assert!(controlled_game(&unmanaged).is_err());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        verify_gateway_owner(&log, port, std::process::id()).unwrap();
        assert!(verify_gateway_owner(&log, port, u32::MAX).is_err());
        drop(listener);
        assert!(verify_gateway_owner(&log, port, std::process::id()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_stale_partial_and_mismatched_launch_results() {
        let success = json!({"protocol":1,"ok":true,"stage":"resumed","pid":42,"created":"134000000000000000","cleanupPending":false});
        assert!(parse_launch_result(success.to_string().as_bytes(), true).is_ok());
        assert!(parse_launch_result(success.to_string().as_bytes(), false).is_err());
        assert!(parse_launch_result(b"", true).is_err());
        let mut incomplete_failure = json!({"protocol":1,"ok":false,"stage":"load"});
        assert!(parse_launch_result(incomplete_failure.to_string().as_bytes(), false).is_err());
        incomplete_failure["cleanupPending"] = json!(true);
        assert!(parse_launch_result(incomplete_failure.to_string().as_bytes(), false).is_ok());
        let mut pending = success.clone();
        pending["cleanupPending"] = json!(true);
        assert!(parse_launch_result(pending.to_string().as_bytes(), true).is_err());
        let mut invalid = success.clone();
        invalid["protocol"] = json!(2);
        assert!(parse_launch_result(invalid.to_string().as_bytes(), true).is_err());
        let executable = Path::new(r"D:\Steam\cs2.exe");
        let status = json!({"processes":[{"pid":42,"created":"134000000000000000","executable":executable}]});
        assert!(validate_game_identity(&status, &success, executable).is_ok());
        let mut stale = status.clone();
        stale["processes"][0]["created"] = json!("134000000000000001");
        assert!(validate_game_identity(&stale, &success, executable).is_err());
        let mut ambiguous = status.clone();
        ambiguous["processes"].as_array_mut().unwrap().push(status["processes"][0].clone());
        assert!(validate_game_identity(&ambiguous, &success, executable).is_err());
    }
}

/// The fixed gateway must be owned by the held game, not just another service on the same port.
fn verify_gateway_owner(log: &DesktopLog, port: u16, pid: u32) -> Result<(), String> {
    let script = format!("$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort {port} | Select-Object -ExpandProperty OwningProcess -Unique); ConvertTo-Json -Compress -InputObject $owners");
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]).creation_flags(0x08000000);
    let output = powershell::run(command, log, "核对 MulNX 网关归属", Duration::from_secs(12))?;
    let owners = powershell::parse(log, "核对 MulNX 网关归属", &output)?;
    if owners.as_array().is_some_and(|owners| owners.len() == 1 && owners[0].as_u64() == Some(pid as u64)) {
        Ok(())
    } else {
        log.event("mulnx_gateway_owner", "failure", Some(&json!({"expectedPid":pid,"owners":owners}).to_string()));
        Err("MulNX 网关不属于当前借用的 CS2，已停止发送控制命令。请重新检查游戏实例。".into())
    }
}

fn controlled_game(cs2: &managed_cs2::ManagedCs2) -> Result<managed_cs2::WorkspaceProcess, String> {
    if !cs2.has_external() { return Err("请先检查并明确借用要停止控制的 CS2 实例。".into()); }
    let (context, game) = cs2.console_source()?.ok_or("当前借用游戏已失效或实例不唯一，请重新检查。")?;
    if game.owned || !game.is_running() { return Err("当前游戏控制归属未确认，未发送停止命令。".into()); }
    let executable = context["executable"].as_str().ok_or("当前游戏安装位置未确认。")?;
    validate_game_identity(&cs2.mulnx_handoff_status()?,
        &json!({"pid":game.pid,"created":game.created.to_string()}), Path::new(executable))?;
    Ok(game)
}

/// Automation requires the held external instance to own the live gateway.
/// Standard and ordinary borrowed games keep the manual connection route.
pub fn observer_control_available(cs2: &managed_cs2::ManagedCs2, log: &DesktopLog) -> bool {
    let Ok(game) = controlled_game(cs2) else { return false; };
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], 55202));
    if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err() {
        return false;
    }
    verify_gateway_owner(log, 55202, game.pid).is_ok()
}

/// Explicit end of MulNX control. Workbench exit intentionally never calls this.
pub fn stop_control(app: &tauri::AppHandle, log: &DesktopLog) -> Result<Value, String> {
    let _launch = LAUNCH_GATE.try_lock().map_err(|_| "MulNX 正忙，请稍后重试。")?;
    let gate = app.state::<production_exit::ExitGate>();
    if !gate.begin() { return Err("正在退出，请等待收尾结果。".into()); }
    let _gate = production_exit::WorkspaceExitGuard(&gate);
    app.state::<updates::PendingUpdate>().check()?;
    let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
    let mut cs2 = managed.lock().map_err(|_| "CS2 正忙，请稍后重试。")?;
    let game = controlled_game(&cs2)?;
    let (context, _) = cs2.console_source()?.ok_or("当前借用游戏身份未确认，未发送停止命令。")?;
    let identity = crate::mulnx_stop::Identity { pid:game.pid, created:game.created,
        executable:PathBuf::from(context["executable"].as_str().ok_or("当前游戏安装位置未确认。")?) };
    if crate::mulnx_stop::blocked(log, &identity)? { return Ok(crate::mulnx_stop::uncertain("already-submitted")); }
    verify_gateway_owner(log, 55202, game.pid)?;
    production_exit::finish_workspace_production(log)?;
    let stopped = crate::mulnx_stop::submit(log, &identity, || {
        // Restoration failure keeps the journal and does not submit unload.
        crate::observer_workspace::finish(log)?;
        let current = controlled_game(&cs2)?;
        if current.pid != game.pid || current.created != game.created || !game.is_running() {
            return Err("游戏实例已变化，未发送停止命令。".into());
        }
        verify_gateway_owner(log, 55202, game.pid)?;
        let receipt = log.state_root.join("data/mulnx-launch/current.json");
        match std::fs::remove_file(receipt) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(log.preserve_error("mulnx_stop_receipt", None, &error, "旧启动记录未能失效，已保留 MulNX 供重试。".to_string())),
        }
        let root = crate::bundle_root()?;
        let mut command = Command::new(root.join("resources/runtime/node.exe"));
        command.arg(root.join("resources/app/dist/orchestration/provider.js")).arg("--stop-mulnx")
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").creation_flags(0x08000000);
        Ok(command)
    }, |command| {
        let output = powershell::run(command, log, "停止 MulNX 控制", Duration::from_secs(8))?;
        let result = powershell::parse(log, "停止 MulNX 控制", &output)?;
        log.event("mulnx_stop", "result", Some(&result.to_string()));
        Ok(result) // queued is only submission; the reservation also covers unknown/rejected outcomes.
    });
    // The verified borrowed game remains alive. Safe production finish has already succeeded;
    // even HUD/transport failure must not leave the borrowed lease or workbench active.
    let detached = cs2.finish();
    crate::refresh_finished_window_feedback(app, &cs2);
    drop(cs2);
    let preparation = crate::open_main(app.clone(), None, None);
    let hidden = crate::hide_workspace(app);
    let cleanup = production_exit::cleanup_results(detached,
        production_exit::cleanup_results(preparation, hidden));
    if let (Ok(value), Err(error)) = (&stopped, &cleanup) {
        if value["stopGuard"].is_string() {
            log.event("mulnx_stop_cleanup", "failure", Some(error));
            let mut value = value.clone();
            value["cleanupPending"] = true.into();
            return Ok(value);
        }
    }
    match (stopped, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(stop), Err(cleanup)) => Err(format!("{stop}\n{cleanup}")),
    }
}
