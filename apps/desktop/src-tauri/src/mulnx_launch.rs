//! The native host selects the installation and opens the managed upstream launcher.
use crate::{cs2_activity, gsi_script, managed_cs2, powershell, production_exit, startup_log::DesktopLog, updates};
use std::{io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}, process::Command};
use std::os::windows::{ffi::OsStrExt, process::CommandExt};
use serde_json::{Value, json};
use tauri::Manager;
static LAUNCH_GATE: Mutex<()> = Mutex::new(());

#[repr(C)]
struct StartupInfo {
    size: u32, reserved: *mut u16, desktop: *mut u16, title: *mut u16,
    x: u32, y: u32, x_size: u32, y_size: u32, x_chars: u32, y_chars: u32,
    fill: u32, flags: u32, show: u16, reserved_size: u16, reserved2: *mut u8,
    stdin: isize, stdout: isize, stderr: isize,
}
#[repr(C)]
struct ProcessInformation { process: isize, thread: isize, pid: u32, tid: u32 }
#[link(name = "kernel32")]
extern "system" {
    fn CreateProcessW(application: *const u16, command: *mut u16, process_attributes: *const std::ffi::c_void,
        thread_attributes: *const std::ffi::c_void, inherit: i32, flags: u32, environment: *const std::ffi::c_void,
        directory: *const u16, startup: *const StartupInfo, info: *mut ProcessInformation) -> i32;
    fn WaitForSingleObject(handle: isize, timeout: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn TerminateProcess(handle: isize, exit_code: u32) -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(isize, isize) -> i32, data: isize) -> i32;
    fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
    fn PostMessageW(window: isize, message: u32, wparam: usize, lparam: isize) -> i32;
}
unsafe extern "system" fn close_launcher_window(window: isize, data: isize) -> i32 {
    let mut pid = 0;
    GetWindowThreadProcessId(window, &mut pid);
    if pid == data as u32 { PostMessageW(window, 0x0010, 0, 0); }
    1
}
pub(crate) struct HiddenLauncher { process: isize, pid: u32 }
impl Drop for HiddenLauncher { fn drop(&mut self) { unsafe { CloseHandle(self.process); } } }
impl HiddenLauncher {
    fn spawn(path: &Path) -> std::io::Result<Self> {
        let application: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let directory: Vec<u16> = path.parent().ok_or_else(|| std::io::Error::other("launcher directory missing"))?
            .as_os_str().encode_wide().chain(Some(0)).collect();
        let mut command = vec![b'"' as u16];
        command.extend(path.as_os_str().encode_wide());
        command.extend([b'"' as u16, 0]);
        let mut startup: StartupInfo = unsafe { std::mem::zeroed() };
        startup.size = std::mem::size_of::<StartupInfo>() as u32;
        startup.flags = 1; // STARTF_USESHOWWINDOW
        startup.show = 0; // SW_HIDE, consumed by the launcher's first ShowWindow(SW_SHOWDEFAULT).
        let mut info: ProcessInformation = unsafe { std::mem::zeroed() };
        if unsafe { CreateProcessW(application.as_ptr(), command.as_mut_ptr(), std::ptr::null(), std::ptr::null(),
            0, 0x08000000, std::ptr::null(), directory.as_ptr(), &startup, &mut info) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe { CloseHandle(info.thread); }
        Ok(Self { process: info.process, pid: info.pid })
    }
    pub(crate) fn pid(&self) -> u32 { self.pid }
    pub(crate) fn running(&self) -> std::io::Result<bool> {
        match unsafe { WaitForSingleObject(self.process, 0) } {
            0 => Ok(false), 258 => Ok(true), _ => Err(std::io::Error::last_os_error()),
        }
    }
    pub(crate) fn stop(&self) -> std::io::Result<()> {
        if !self.running()? { return Ok(()); }
        unsafe { EnumWindows(close_launcher_window, self.pid as isize); }
        match unsafe { WaitForSingleObject(self.process, 3000) } {
            0 => return Ok(()), 258 => (), _ => return Err(std::io::Error::last_os_error()),
        }
        if unsafe { TerminateProcess(self.process, 0) } == 0 {
            let error = std::io::Error::last_os_error();
            if self.running()? { return Err(error); }
        }
        if unsafe { WaitForSingleObject(self.process, 5000) } != 0 {
            return Err(std::io::Error::other("launcher did not exit"));
        }
        Ok(())
    }
}

fn launcher_start_message(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(225 | 226) => "Windows 安全防护阻止启动 MulNX，请核对官方来源并在 Windows 安全中心查看检测记录。处理后重新进入工作台；仍无法使用时，可在设置 → 游戏与观战 → CS2 启动设置中选择标准启动并保存。",
        _ => "MulNX 未能启动。",
    }
}

/// Attachment is an internal continuation of a launch initiated by Mizar.
/// A running game, matching installation or live gateway alone grants no entry.
pub fn verify_managed_launch(log: &DesktopLog, actual: &Value, pid: u32, created: u64, executable: &Path) -> Result<(), String> {
    let denied = "当前 CS2 不是由 Mizar 启动，请先退出游戏，再从 Mizar 打开工作台。";
    let bytes = std::fs::read(log.state_root.join("data/mulnx-launch/current.json")).map_err(|_| denied)?;
    let receipt = parse_launch_result(&bytes).map_err(|_| denied)?;
    if receipt["pid"].as_u64() != Some(pid as u64)
        || receipt["created"].as_str().and_then(|value| value.parse::<u64>().ok()) != Some(created) {
        return Err(denied.into());
    }
    validate_game_identity(actual, &receipt, executable).map_err(|_| denied.into())
}

pub fn launch(app: &tauri::AppHandle, log: &DesktopLog, automatic: bool, preserve: bool) -> Result<Value, String> {
    if !automatic { return Err("请从 Mizar 自动启动 MulNX 工作台。".into()); }
    launch_operation(app, log, true, false, preserve, None, false)
}

/// Only reconcile an existing submitted request; absence never starts a new one.
pub fn resume(app: &tauri::AppHandle, log: &DesktopLog) -> Result<Value, String> {
    let _launch = LAUNCH_GATE.try_lock().map_err(|_| "MulNX 正在启动，请稍后重试。")?;
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
    Ok(resume_pending_launch(log, &managed, None)?.unwrap_or_else(|| json!({"result":"not-found"})))
}

pub fn resume_demo(app: &tauri::AppHandle, log: &DesktopLog, request_id: &str) -> Result<Value, String> {
    let _launch = demo_launch_guard()?;
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
    Ok(resume_pending_launch(log, &managed, Some(request_id))?.unwrap_or_else(|| json!({"result":"not-found"})))
}

pub fn update(app: &tauri::AppHandle, log: &DesktopLog) -> Result<Value, String> {
    launch_operation(app, log, false, true, false, None, false)
}

pub fn demo_launch_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    LAUNCH_GATE.try_lock().map_err(|_| "MulNX 正在启动，请等待本次操作完成。".into())
}

pub fn launch_demo(app: &tauri::AppHandle, log: &DesktopLog, path: &Path, request_id: &str, preserve: bool, _guard: &std::sync::MutexGuard<'static, ()>) -> Result<Value, String> {
    launch_operation(app, log, true, false, preserve, Some((path, request_id)), true)
}

fn launch_operation(app: &tauri::AppHandle, log: &DesktopLog, automatic: bool, update_only: bool, preserve: bool, demo: Option<(&Path, &str)>, guarded: bool) -> Result<Value, String> {
    let _launch = if guarded { None } else { Some(demo_launch_guard()?) };
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
    if automatic && demo.is_none() {
        if let Some(receipt) = resume_pending_launch(log, &managed, None)? { return Ok(receipt); }
    }
    let status = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.status()?;
    if preserve && status["canPreserve"] != true {
        return Err("请先检查配置接管结果，再选择保持原游戏设置继续。".into());
    }
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
    if automatic && results.join("pending.json").exists() {
        let actual = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_handoff_status()?;
        if !actual["processes"].as_array().is_some_and(|p| p.is_empty()) {
            return Err("上次 MulNX 启动结果待确认；请检查并退出 CS2 和启动器后重试。".into());
        }
        if managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_launcher_running()? {
            return Err("上次 MulNX 启动结果待确认；请关闭启动器并检查游戏后重试。".into());
        }
        std::fs::remove_file(results.join("pending.json")).map_err(|e| e.to_string())?;
    }
    if automatic {
        let actual = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_handoff_status()?;
        if actual["processes"].as_array().is_some_and(|processes| !processes.is_empty()) {
            let receipt = std::fs::read(results.join("current.json")).ok()
                .and_then(|bytes| parse_launch_result(&bytes).ok());
            if let Some(receipt) = receipt {
                if validate_game_identity(&actual, &receipt, &executable).is_ok() {
                    let pid = receipt["pid"].as_u64().ok_or("无法确认游戏，请稍后重试。")? as u32;
                    let created = receipt["created"].as_str().and_then(|s| s.parse::<u64>().ok()).ok_or("无法确认游戏，请稍后重试。")?;
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
            return Err("当前 CS2 不是由 Mizar 启动，请先退出游戏，再从 Mizar 打开工作台。".into());
        }
    }
    if status["spectatorRecoveryPending"] == true { return Err("请先完成上次游戏配置恢复。".into()); }
    no_game()?;
    if automatic && managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_launcher_running()? {
        return Err("MulNX 启动器仍在运行，请先关闭它，再重试启动。".into());
    }
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
    crate::observer_hud::preflight(log, status["preferMulnx"] == true)?;
    std::fs::create_dir_all(&results).map_err(|e| e.to_string())?;
    let pending = results.join("pending.json");
    crate::cs2_session::atomic_write(&pending, b"{}")?;
    let journal = {
        let mut cs2 = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?;
        if let Some((path, id)) = demo {
            cs2.prepare_managed_mulnx_demo(&executable, preserve, path, id)?
        } else {
            cs2.prepare_managed_mulnx(&executable, preserve)?
        }
    };
    let spectator_cfg = journal["spectatorCfg"] == true;
    let demo_cfg = journal["demoPlaybackCfg"]["name"].as_str();
    let configured = production_exit::prepare_mulnx_with_demo(log, &executable, false, spectator_cfg, demo_cfg)?;
    if configured["launcher"] != prepared["launcher"] || configured["version"] != prepared["version"] {
        return Err("启动器身份或版本已变化；原配置备份仍保留。".into());
    }
    let outcome = (|| -> Result<Value, String> {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        no_game()?;
        std::fs::create_dir_all(&results).map_err(|error| log.preserve_error("mulnx_launch", None, &error, "无法准备 MulNX 启动记录。"))?;
        let child = Arc::new(HiddenLauncher::spawn(&launcher)
            .map_err(|error| log.preserve_error("mulnx_launch", None, &error, launcher_start_message(&error)))?);
        managed.lock().map_err(|_| "CS2 状态不可用，请关闭本次 MulNX 启动器后恢复。")?
            .remember_mulnx_launcher(Arc::clone(&child));
        std::fs::write(&pending, json!({"launcherPid":child.pid, "executable":executable}).to_string())
            .map_err(|error| log.preserve_error("mulnx_launch", None, &error, "无法记录启动状态，请关闭 MulNX 并检查游戏。"))?;
        log.event("mulnx_launch", "begin", Some(&json!({"launcherPid":child.pid,"version":prepared["version"]}).to_string()));
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if !child.running().map_err(|e| e.to_string())? { return Err("MulNX 启动器已退出，请检查游戏状态。".into()); }
            if std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127,0,0,1],55203)), Duration::from_millis(200)).is_ok() {
                verify_gateway_owner(log, 55203, child.pid)?;
                break;
            }
            if Instant::now() >= deadline { return Err("MulNX 启动接口不可用，请检查更新或选择标准启动；请关闭启动器后重试。".into()); }
            std::thread::sleep(Duration::from_millis(200));
        }
        no_game()?;
        let root = crate::bundle_root()?;
        let mut request = Command::new(root.join("resources/runtime/node.exe"));
        request.arg(root.join("resources/app/dist/orchestration/provider.js")).arg("--launch-mulnx")
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").creation_flags(0x08000000);
        let mut record = std::fs::File::create(&pending).map_err(|e| e.to_string())?;
        record.write_all(json!({"launcherPid":child.pid, "executable":executable, "request":"submitted"}).to_string().as_bytes())
            .and_then(|()| record.sync_all()).map_err(|e| e.to_string())?;
        managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.submit_managed_mulnx()?;
        let response = powershell::run(request, log, "请求 MulNX 启动", Duration::from_secs(8));
        log.event("mulnx_launch_request", "submitted", Some(&format!("{:?}", response)));
        // No retry: an interrupted request can still have been queued.
        let deadline = Instant::now() + Duration::from_secs(120);
        let result = loop {
            let actual = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.mulnx_handoff_status()?;
            if let Some(processes) = actual["processes"].as_array() {
                if processes.len() == 1 {
                    let process = &processes[0];
                    let candidate = json!({"mizarLaunch":1,"pid":process["pid"],"created":process["created"]});
                    if validate_game_identity(&actual, &candidate, &executable).is_ok()
                        && verify_gateway_owner(log, 55202, process["pid"].as_u64().unwrap_or(0) as u32).is_ok() {
                        break candidate;
                    }
                } else if processes.len() > 1 { return Err("检测到多个 CS2，请检查后退出游戏与 MulNX。".into()); }
            }
            if Instant::now() >= deadline { return Err("MulNX 启动结果待确认；请检查游戏和启动器，退出后再重试。".into()); }
            std::thread::sleep(Duration::from_secs(1));
        };
        let bytes = result.to_string();
        let pid = result["pid"].as_u64().ok_or("MulNX 游戏进程身份缺失。")? as u32;
        let created = result["created"].as_str().and_then(|s| s.parse::<u64>().ok()).ok_or("无法确认游戏，请稍后重试。")?;
        managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?.bind_managed_mulnx(pid, created, &executable)?;
        let temporary = results.join(format!("current-{}.tmp", log.session_id));
        std::fs::write(&temporary, bytes.as_bytes())
            .and_then(|()| std::fs::rename(&temporary, results.join("current.json")))
            .map_err(|error| log.preserve_error("mulnx_launch_receipt", None, &error, "无法保存游戏身份，启动结果待确认。"))?;
        Ok(result)
    })();
    let cleanup = production_exit::prepare_mulnx(log, &executable, false, false);
    if let Err(error) = cleanup { return Err(format!("MulNX 启动参数清理失败，原备份仍保留：{error}")); }
    if outcome.is_ok() { std::fs::remove_file(&pending).map_err(|e| e.to_string())?; }
    outcome
}

/// Resume only a submitted request whose launcher is still owned by this Host.
/// Never submit a second request or adopt a process after Host restart.
fn resume_pending_launch(log: &DesktopLog, managed: &Mutex<managed_cs2::ManagedCs2>, demo_id: Option<&str>) -> Result<Option<Value>, String> {
    let results = log.state_root.join("data/mulnx-launch");
    let pending = results.join("pending.json");
    let bytes = match std::fs::read(&pending) {
        Ok(bytes) if bytes.len() <= 16 * 1024 => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => return Err("无法读取启动状态，请恢复设置。".into()),
    };
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "启动状态不完整，请恢复设置。")?;
    if record["request"] != "submitted" { return Ok(None); }
    let pid = record["launcherPid"].as_u64().filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
        .ok_or("无法确认启动器，请恢复设置。")? as u32;
    let executable = PathBuf::from(record["executable"].as_str().ok_or("无法确认游戏位置，请恢复设置。")?);
    let cs2 = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?;
    if let Some(id) = demo_id {
        let trial = crate::demo_test::status(log)?;
        if trial["active"] != true || trial["phase"] != "starting"
            || trial["requestId"].as_str() != Some(id) || !cs2.matches_pending_demo(id)? {
            return Err("Demo 试播状态已变化，请刷新后重试。".into());
        }
    }
    if !cs2.owns_mulnx_launcher(pid)? { return Err("无法确认本次启动，请关闭游戏和 MulNX 后恢复设置。".into()); }
    verify_gateway_owner(log, 55203, pid)?;
    let actual = cs2.mulnx_handoff_status()?;
    let processes = actual["processes"].as_array().ok_or("CS2 实例状态不可用。")?;
    if processes.len() != 1 { return Err("游戏尚未就绪，请稍后重试。".into()); }
    let process = &processes[0];
    let result = json!({"mizarLaunch":1,"pid":process["pid"],"created":process["created"]});
    validate_game_identity(&actual, &result, &executable)?;
    let game_pid = result["pid"].as_u64().ok_or("无法确认游戏，请稍后重试。")? as u32;
    let created = result["created"].as_str().and_then(|v| v.parse::<u64>().ok()).ok_or("无法确认游戏，请稍后重试。")?;
    verify_gateway_owner(log, 55202, game_pid)?;
    if managed_cs2::process_parent(game_pid, log)? != Some(pid) || !cs2.owns_mulnx_launcher(pid)? {
        return Err("无法确认本次启动，请关闭游戏和 MulNX 后恢复设置。".into());
    }
    cs2.bind_managed_mulnx(game_pid, created, &executable)?;
    crate::cs2_session::atomic_write(&results.join("current.json"), result.to_string().as_bytes())?;
    production_exit::prepare_mulnx(log, &executable, false, false)?;
    std::fs::remove_file(&pending).map_err(|e| e.to_string())?;
    log.event("mulnx_launch_reuse", "success", Some(&result.to_string()));
    Ok(Some(result))
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

fn parse_launch_result(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > 16 * 1024 { return Err("MulNX 启动记录过大。".into()); }
    let result: Value = serde_json::from_slice(bytes).map_err(|_| "MulNX 启动记录不完整。")?;
    if result["mizarLaunch"] != 1 || !result["pid"].as_u64().is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64)
        || result["created"].as_str().and_then(|value| value.parse::<u64>().ok()).is_none() {
        return Err("MulNX 启动记录无效。".into());
    }
    Ok(result)
}

fn validate_game_identity(status: &Value, result: &Value, executable: &Path) -> Result<(), String> {
    let processes = status["processes"].as_array().ok_or("CS2 实例状态不可用。")?;
    if processes.len() != 1 || processes[0]["pid"] != result["pid"] || processes[0]["created"] != result["created"]
        || !processes[0]["executable"].as_str().is_some_and(|path| path.eq_ignore_ascii_case(&executable.to_string_lossy())) {
        return Err("记录的 CS2 实例与本机实际进程不一致，请检查游戏状态。".into());
    }
    Ok(())
}

/// The fixed gateway must be owned by the held game, not just another service on the same port.
fn verify_gateway_owner(log: &DesktopLog, port: u16, pid: u32) -> Result<(), String> {
    let script = format!("$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort {port} | Select-Object -ExpandProperty OwningProcess -Unique); ConvertTo-Json -Compress -InputObject $owners");
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]).creation_flags(0x08000000);
    let output = powershell::run(command, log, "核对 MulNX 网关归属", Duration::from_secs(30))?;
    let owners = powershell::parse(log, "核对 MulNX 网关归属", &output)?;
    if owners.as_array().is_some_and(|owners| owners.len() == 1 && owners[0].as_u64() == Some(pid as u64)) {
        Ok(())
    } else {
        log.event("mulnx_gateway_owner", "failure", Some(&json!({"expectedPid":pid,"owners":owners}).to_string()));
        Err("MulNX 网关不属于当前借用的 CS2，已停止发送控制命令。请重新检查游戏实例。".into())
    }
}

fn controlled_game(cs2: &managed_cs2::ManagedCs2, log: &DesktopLog) -> Result<managed_cs2::WorkspaceProcess, String> {
    let (context, game) = cs2.console_source()?.ok_or("当前借用游戏已失效或实例不唯一，请重新检查。")?;
    if !game.is_running() { return Err("当前游戏控制归属未确认，未发送停止命令。".into()); }
    let executable = context["executable"].as_str().ok_or("当前游戏安装位置未确认。")?;
    validate_game_identity(&cs2.mulnx_handoff_status()?,
        &json!({"pid":game.pid,"created":game.created.to_string()}), Path::new(executable))?;
    if game.owned { verify_managed_launch(log, &cs2.mulnx_handoff_status()?, game.pid, game.created, Path::new(executable))?; }
    Ok(game)
}

/// Automation requires the verified game instance to own the live gateway.
/// Standard and ordinary borrowed games keep the manual connection route.
pub fn observer_control_available(cs2: &managed_cs2::ManagedCs2, log: &DesktopLog) -> bool {
    let Ok(game) = controlled_game(cs2, log) else { return false; };
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], 55202));
    if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err() {
        return false;
    }
    verify_gateway_owner(log, 55202, game.pid).is_ok()
}

/// Stop this owned MulNX injection before closing its game. An uncertain result
/// retains both the game and the one-shot reservation for operator recovery.
pub fn stop_managed_for_exit(cs2: &managed_cs2::ManagedCs2, log: &DesktopLog) -> Result<(), String> {
    let Some((context, game)) = cs2.console_source()? else { return Ok(()); };
    if !game.owned { return Ok(()); }
    let executable = PathBuf::from(context["executable"].as_str().ok_or("游戏安装位置未确认。")?);
    if context["mulnxLaunch"] != true { return Ok(()); }
    verify_managed_launch(log, &cs2.mulnx_handoff_status()?, game.pid, game.created, &executable)?;
    let game = controlled_game(cs2, log)?;
    let identity = crate::mulnx_stop::Identity { pid: game.pid, created: game.created, executable };
    if crate::mulnx_stop::confirmed(log, &identity)? {
        return crate::mulnx_stop::verify_absent(&game);
    }
    if crate::mulnx_stop::blocked(log, &identity)? {
        crate::mulnx_stop::verify_absent(&game)?;
        return crate::mulnx_stop::mark_confirmed(log, &identity);
    }
    verify_gateway_owner(log, 55202, game.pid)?;
    crate::mulnx_stop::verify_present(&game)?;
    let proof = crate::mulnx_stop::UnloadProof::open(game.pid)?;
    crate::mulnx_stop::verify_present(&game)?;
    verify_gateway_owner(log, 55202, game.pid)?;
    let result = crate::mulnx_stop::submit(log, &identity, || {
        let current = controlled_game(cs2, log)?;
        if current.pid != game.pid || current.created != game.created || !current.is_running() {
            return Err("游戏身份已变化，未发送停止命令。".into());
        }
        crate::mulnx_stop::verify_present(&game)?;
        verify_gateway_owner(log, 55202, game.pid)?;
        let root = crate::bundle_root()?;
        let mut command = Command::new(root.join("resources/runtime/node.exe"));
        command.arg(root.join("resources/app/dist/orchestration/provider.js")).arg("--stop-mulnx")
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").creation_flags(0x08000000);
        Ok(command)
    }, |command| {
        let output = powershell::run(command, log, "停止 MulNX 控制", Duration::from_secs(8))?;
        powershell::parse(log, "停止 MulNX 控制", &output)
    })?;
    log.event("mulnx_stop", "submitted", Some(&result.to_string()));
    proof.confirm(&game)?;
    crate::mulnx_stop::mark_confirmed(log, &identity)?;
    log.event("mulnx_unload", "confirmed", Some(&format!("pid={} created={}", game.pid, game.created)));
    Ok(())
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
    if let Some((context, game)) = cs2.pending_mulnx_stop() {
        let borrowed = cs2.has_external();
        if borrowed && !cs2.external_matches(&game) {
            return Err("游戏状态已变化，请检查后重试。".into());
        }
        if !borrowed && cs2.workspace_process()?.is_some() {
            return Err("已有其他游戏，请结束当前工作台后重试。".into());
        }
        let exited = game.has_exited()?;
        let mut submitted = false;
        if !exited {
            let executable = PathBuf::from(context["executable"].as_str().ok_or("无法确认游戏位置，请检查游戏状态。")?);
            validate_game_identity(&cs2.mulnx_handoff_status()?,
                &json!({"pid":game.pid,"created":game.created.to_string()}), &executable)?;
            let identity = crate::mulnx_stop::Identity { pid:game.pid, created:game.created, executable };
            submitted = crate::mulnx_stop::blocked(log, &identity)?;
            if submitted {
                crate::mulnx_stop::verify_absent(&game)?;
                crate::mulnx_stop::mark_confirmed(log, &identity)?;
            }
        }
        let observer = crate::observer_workspace::finish(log);
        let detached = if borrowed {
            // The same borrowed handle may already be invalidated by a failed Demo cleanup.
            cs2.finish()
        } else { Ok(()) };
        crate::refresh_finished_window_feedback(app, &cs2);
        drop(cs2);
        let preparation = crate::open_main(app.clone(), None, None);
        let hidden = crate::hide_workspace(app);
        production_exit::cleanup_results(observer, production_exit::cleanup_results(detached,
            production_exit::cleanup_results(preparation, hidden)))?;
        managed.lock().map_err(|_| "CS2 正忙，请稍后重试。")?.clear_mulnx_stop();
        return Ok(if exited { json!({"result":"game-exited", "execution":"unconfirmed"}) }
            else if !submitted { json!({"result":"not-submitted", "execution":"unconfirmed"}) }
            else { json!({"result":"unknown", "execution":"confirmed", "stopGuard":"already-submitted"}) });
    }
    let game = controlled_game(&cs2, log)?;
    if game.owned { return Err("请结束工作台后再停止游戏。".into()); }
    let (context, _) = cs2.console_source()?.ok_or("当前借用游戏身份未确认，未发送停止命令。")?;
    let identity = crate::mulnx_stop::Identity { pid:game.pid, created:game.created,
        executable:PathBuf::from(context["executable"].as_str().ok_or("当前游戏安装位置未确认。")?) };
    if crate::mulnx_stop::blocked(log, &identity)? {
        crate::mulnx_stop::verify_absent(&game)?;
        crate::mulnx_stop::mark_confirmed(log, &identity)?;
        production_exit::finish_workspace_production(log)?;
        crate::observer_workspace::finish(log)?;
        cs2.remember_mulnx_stop(context, game);
        let detached = cs2.finish();
        crate::refresh_finished_window_feedback(app, &cs2);
        drop(cs2);
        let preparation = crate::open_main(app.clone(), None, None);
        let hidden = crate::hide_workspace(app);
        production_exit::cleanup_results(detached, production_exit::cleanup_results(preparation, hidden))?;
        managed.lock().map_err(|_| "CS2 正忙，请稍后重试。")?.clear_mulnx_stop();
        return Ok(json!({"result":"unknown", "execution":"confirmed", "stopGuard":"already-submitted"}));
    }
    verify_gateway_owner(log, 55202, game.pid)?;
    crate::mulnx_stop::verify_present(&game)?;
    let proof = crate::mulnx_stop::UnloadProof::open(game.pid)?;
    crate::mulnx_stop::verify_present(&game)?;
    verify_gateway_owner(log, 55202, game.pid)?;
    production_exit::finish_workspace_production(log)?;
    let stopped = crate::mulnx_stop::submit(log, &identity, || {
        // Restoration failure keeps the journal and does not submit unload.
        crate::observer_workspace::finish(log)?;
        let current = controlled_game(&cs2, log)?;
        if current.pid != game.pid || current.created != game.created || !game.is_running() {
            return Err("游戏实例已变化，未发送停止命令。".into());
        }
        crate::mulnx_stop::verify_present(&game)?;
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
    let stopped = stopped.and_then(|mut value| {
        proof.confirm(&game)?;
        crate::mulnx_stop::mark_confirmed(log, &identity)?;
        value["execution"] = "confirmed".into();
        Ok(value)
    });
    // The verified borrowed game remains alive. Safe production finish has already succeeded;
    // even HUD/transport failure must not leave the borrowed lease or workbench active.
    let reserved = !matches!(crate::mulnx_stop::blocked(log, &identity), Ok(false));
    if reserved || stopped.is_err() { cs2.remember_mulnx_stop(context, game); }
    let detached = cs2.finish();
    crate::refresh_finished_window_feedback(app, &cs2);
    drop(cs2);
    let preparation = crate::open_main(app.clone(), None, None);
    let hidden = crate::hide_workspace(app);
    let cleanup = production_exit::cleanup_results(detached,
        production_exit::cleanup_results(preparation, hidden));
    if reserved && stopped.is_ok() && cleanup.is_ok() {
        managed.lock().map_err(|_| "CS2 正忙，请稍后重试。")?.clear_mulnx_stop();
    }
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
