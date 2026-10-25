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
    if status["pending"] == true || status["spectatorRecoveryPending"] == true || status["demoCleanupPending"] == true {
        return Err("请先完成原有 CS2 配置恢复，再通过 MulNX 启动。".into());
    }
    if !update_only { crate::observer_hud::preflight(log, status["preferMulnx"] == true)?; }
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
                    log.event("mulnx_launch_reuse", "success", Some(&receipt.to_string()));
                    return Ok(receipt);
                }
            }
            return Err("已有 CS2 与本次 MulNX 启动记录不匹配，请先退出它，或从外部游戏交接入口明确选择。".into());
        }
    }
    no_game()?;
    let prepared = production_exit::prepare_mulnx(log, &executable, update_only)?;
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
    if automatic && prepared["launchProtocol"] != 1 {
        return Err("当前 MulNX 版本尚不支持保留环境检查的一键启动，请更新支持此接口的官方版本。".into());
    }
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    // The official launcher can start the engine later. Preserve the prior raw
    // file before giving it control; this grants no ownership of that game.
    crate::cs2_console::prepare(log, &executable)?;
    if automatic {
        std::fs::create_dir_all(&results).map_err(|error| log.preserve_error("mulnx_launch", None, &error, "无法准备 MulNX 启动记录。"))?;
        let result_path = results.join(format!("{}-{}.json", log.session_id, chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        let mut child = Command::new(&launcher).arg("--launch-result").arg(&result_path)
            .current_dir(launcher.parent().ok_or("MulNX 目录无效。")?)
            .creation_flags(0x08000000).spawn()
            .map_err(|error| log.preserve_error("mulnx_launch", None, &error, "MulNX 未能启动。"))?;
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
            return Err(if result["cleanupPending"] == true {
                "MulNX 启动未完成，且本次游戏收尾待确认。请在运行诊断中核对进程状态后重试。"
            } else if result["stage"] == "environment" {
                "MulNX 环境检查未通过，请先关闭完美世界竞技平台等第三方游戏平台，再检查运行诊断并重试。"
            } else {
                "MulNX 启动失败，本次游戏已收尾。请在运行诊断中查看原始错误后重试。"
            }.into());
        }
        validate_game_identity(&managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_handoff_status()?, &result, &executable)?;
        let temporary = results.join(format!("current-{}.tmp", log.session_id));
        if let Err(error) = std::fs::write(&temporary, &bytes)
            .and_then(|()| std::fs::rename(&temporary, results.join("current.json"))) {
            log.preserve_error("mulnx_launch_receipt", None, &error, ());
        }
        return Ok(result);
    }
    let target: Vec<u16> = format!("{}\0", launcher.display()).encode_utf16().collect();
    let directory: Vec<u16> = format!("{}\0", launcher.parent().ok_or("MulNX 目录无效。")?.display()).encode_utf16().collect();
    let result = unsafe { ShellExecuteW(0, verb.as_ptr(), target.as_ptr(), std::ptr::null(), directory.as_ptr(), 1) };
    if result <= 32 { return Err(format!("MulNX 未能打开（系统代码 {result}）。")); }
    log.event("mulnx_launch", "success", Some(&format!("version={}", prepared["version"])));
    Ok(Value::Null)
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
    verify_gateway_owner(log, 55202, game.pid)?;
    production_exit::finish_workspace_production(log)?;
    let stopped = (|| -> Result<Value, String> {
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
        let output = powershell::run(command, log, "停止 MulNX 控制", Duration::from_secs(8))?;
        let result = powershell::parse(log, "停止 MulNX 控制", &output)?;
        log.event("mulnx_stop", "result", Some(&result.to_string()));
        if result["result"] != "queued" {
            return Err(if result["result"] == "rejected" {
                "当前 MulNX 未接受停止控制；该版本可能不支持 System/Stop，请使用官方退出入口。"
            } else { "MulNX 停止结果待确认，请在游戏内核对；不会自动重发停止命令。" }.into());
        }
        Ok(result) // queued, execution unconfirmed; never claim DLL unloaded.
    })();
    // The verified borrowed game remains alive. Safe production finish has already succeeded;
    // even HUD/transport failure must not leave the borrowed lease or workbench active.
    let detached = cs2.finish();
    crate::refresh_finished_window_feedback(app, &cs2);
    drop(cs2);
    let preparation = crate::open_main(app.clone(), None, None);
    let hidden = crate::hide_workspace(app);
    let cleanup = production_exit::cleanup_results(detached,
        production_exit::cleanup_results(preparation, hidden));
    match (stopped, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(stop), Err(cleanup)) => Err(format!("{stop}\n{cleanup}")),
    }
}
