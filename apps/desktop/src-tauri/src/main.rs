#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod observer_hud;
mod observer_job;
mod observer_workspace;
mod cs2_activity;
mod cs2_diagnostics;
mod cs2_console;
mod cs2_frame_rate;
mod cs2_preferences;
mod cs2_session;
mod cs2_config_identity;
mod cs2_spectator;
mod spectator_recovery_plan;
mod spectator_eligibility;
mod spectator_recovery_vcfg;
mod spectator_snapshot;
mod cs2_video;
mod default_resource;
mod default_resource_vpk;
mod demo_test;
mod desktop_worker;
mod geometry;
mod managed_cs2;
mod mulnx_launch;
mod mulnx_stop;
mod obs_configuration;
mod powershell;
mod production_exit;
mod startup_log;
mod startup_wait;
mod startup_recovery;
mod support_export;
mod updates;
mod window_frame;
mod window_presentation;
mod windows_host;
mod windows_startup;
mod workspace_focus;
mod workspace_group;
mod workspace_shell;

use desktop_worker::DesktopWorker;
use geometry::{Layout, Rect};
use startup_log::DesktopLog;
use std::{
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use windows_host::GameTracker;
use windows_startup::{failure_dialog, DesktopMutex, ExitRequest, ExitSignal, RuntimeJob};

const BASE: &str = "http://127.0.0.1:3000";
static GSI_OPERATION_LOCK: Mutex<()> = Mutex::new(());

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: isize,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

struct HostState {
    tracker: Arc<Mutex<GameTracker>>,
    visible: Arc<AtomicBool>,
    layout_dirty: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    live_window_lock: Mutex<()>,
    tray_available: AtomicBool,
    fullscreen_scope: Mutex<workspace_shell::FullscreenScope>,
    window_group: Mutex<workspace_group::Group>,
    entry_focus: Mutex<workspace_focus::Entry>,
}

fn bundle_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("无法定位产品安装目录：{error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位产品安装目录。".to_string())
}

fn supervisor(root: &Path, argument: &str, startup: Option<&DesktopLog>) -> Result<Child, String> {
    let node = root.join("resources/runtime/node.exe");
    let script = root.join("resources/scripts/product-runtime.mjs");
    if !node.is_file() || !script.is_file() {
        return Err("产品运行文件缺失，请重新解压完整产品包。".into());
    }
    let mut command = Command::new(node);
    command
        .arg(script)
        .arg(argument)
        .current_dir(root)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("MIZAR_DESKTOP_SUPERVISED")
        .stdin(if startup.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    if let Some(log) = startup {
        command
            .env("MIZAR_STARTUP_SESSION_ID", &log.session_id)
            .env("MIZAR_STATE_ROOT", &log.state_root)
            .env("MIZAR_DESKTOP_SUPERVISED", "1")
            .env("MIZAR_OBSERVER_JOB", observer_job::name(&log.session_id))
            .env("MIZAR_OBSERVER_HOST", std::env::current_exe().map_err(|e| e.to_string())?);
    }
    command
        .spawn()
        .map_err(|error| format!("制播服务未能启动：{error:?}"))
}

fn health_matches(root: &Path) -> bool {
    let Ok(bytes) = fs::read(root.join("resources/metadata/artifact.json")) else {
        return false;
    };
    let Ok(artifact) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let address: SocketAddr = "127.0.0.1:3000".parse().expect("fixed loopback address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream
        .take(64 * 1024)
        .read_to_string(&mut response)
        .is_err()
    {
        return false;
    }
    let Some(body) = response.split("\r\n\r\n").nth(1) else {
        return false;
    };
    let Ok(health) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    health["product"]["repository"] == "Starfie1d1272/Mizar"
        && health["product"]["mode"] == "product"
        && health["product"]["artifactSha256"] == artifact["artifactSha256"]
}

fn wait_for_runtime(
    root: &Path,
    child: &mut Child,
    log: Option<&DesktopLog>,
) -> Result<(), String> {
    let mut wait = startup_wait::StartupWait::new(Instant::now());
    loop {
        if health_matches(root) {
            return Ok(());
        }
        let progress = log
            .map(|log| {
                startup_wait::read_progress(
                    &log.directory.join("supervisor.ndjson"),
                    &log.session_id,
                )
            })
            .unwrap_or_default();
        if let Some(error) = &progress.error {
            return Err(error.clone());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("制播服务进程状态读取失败：{error:?}"))?
        {
            return Err(format!("制播服务未能启动（{status}）；请查看运行日志。"));
        }
        wait.update(Instant::now(), &progress);
        if wait.expired(Instant::now()) {
            return Err(wait.timeout_message(&progress));
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn wait_child(child: &mut Child, timeout: Duration) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            return Err("等待进程退出超时。".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn stop_runtime(root: &Path, log: Option<&DesktopLog>) -> Result<(), String> {
    let mut child = supervisor(root, "--stop", None)?;
    match wait_child(&mut child, Duration::from_secs(40)) {
        Ok(status) if status.success() => {
            if let Ok(scope) = shutdown_scope(root) {
                ExitSignal::notify_stopped(&scope);
            }
            Ok(())
        }
        outcome => {
            let _ = child.kill();
            let _ = child.wait();
            let error = format!("停止制播服务未完成：{outcome:?}");
            if let Some(log) = log {
                log.event("runtime_stop", "failure", Some(&error));
            }
            Err(error)
        }
    }
}

fn shutdown_scope(root: &Path) -> Result<String, String> {
    let state = startup_log::writable_root(
        root,
        std::env::var_os("MIZAR_STATE_ROOT").map(PathBuf::from),
    )
    .map_err(|error| error.to_string())?;
    let artifact: serde_json::Value = serde_json::from_slice(
        &fs::read(root.join("resources/metadata/artifact.json"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let digest = artifact["artifactSha256"]
        .as_str()
        .filter(|value| value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("程序资源摘要缺失。")?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    state.to_string_lossy().to_lowercase().hash(&mut hash);
    Ok(format!("{digest}-{:016x}", hash.finish()))
}

fn runtime_owned(log: &DesktopLog, supervisor_pid: u32) -> bool {
    let path = log.state_root.join("data/runtime.json");
    if fs::metadata(&path).map_or(true, |info| info.len() > 64 * 1024) {
        return false;
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|state| {
            state["startupSessionId"].as_str() == Some(&log.session_id)
                && state["supervisorPid"].as_u64() == Some(supervisor_pid as u64)
        })
}

fn webview_preflight() -> Result<String, String> {
    // An explicit fixed runtime path is also a real deployment failure mode.
    if let Some(folder) =
        std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").filter(|v| !v.is_empty())
    {
        fs::metadata(PathBuf::from(folder).join("msedgewebview2.exe"))
            .map_err(|error| format!("指定的 WebView2 Runtime 不可用：{error:?}"))?;
    }
    tauri::webview_version().map_err(|error| format!("Microsoft Edge WebView2 Runtime 不可用，请安装或修复 Evergreen Runtime 后重试。\n{error}\n{error:?}"))
}

fn placement(window: &tauri::WebviewWindow, rect: Rect) {
    let _ = window_presentation::place(window, rect);
}

fn apply_layout(app: &tauri::AppHandle, layout: Layout) {
    if let Some(left) = app.get_webview_window("workspace-left") {
        placement(&left, layout.left);
    }
    if let Some(dock) = app.get_webview_window("workspace-dock") {
        placement(&dock, layout.dock);
    }
}

fn sync_workspace_shell(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    let visible = state.visible.load(Ordering::Relaxed);
    let mut windows = Vec::new();
    if visible {
        for label in ["workspace-left", "workspace-dock"] {
            if let Some(hwnd) = app
                .get_webview_window(label)
                .and_then(|window| window.hwnd().ok())
            {
                windows.push(hwnd.0 as isize);
            }
        }
        if let Ok(tracker) = state.tracker.lock() {
            if let Some(game) = tracker.window {
                windows.push(game.hwnd);
            }
        }
    }
    let marked = state
        .fullscreen_scope
        .lock()
        .is_ok_and(|mut scope| scope.synchronize(&windows));
    if let Ok(mut tracker) = state.tracker.lock() {
        tracker.fullscreen_layout = visible && marked;
    };
}

fn overlay_workspace_windows(app: &tauri::AppHandle) -> Vec<isize> {
    ["workspace-left", "workspace-dock"].iter().filter_map(|label| {
        app.get_webview_window(label).and_then(|window| window.hwnd().ok()).map(|hwnd| hwnd.0 as isize)
    }).collect()
}

fn update_overlay(app: &tauri::AppHandle, state: &HostState) {
    let workspace_windows = overlay_workspace_windows(app);
    let rect = if state.visible.load(Ordering::Relaxed) {
        state
            .tracker
            .lock()
            .ok()
            .and_then(|tracker| tracker.overlay_rect(&workspace_windows))
    } else {
        None
    };
    present_overlay(app, rect);
}

fn present_overlay(app: &tauri::AppHandle, rect: Option<Rect>) {
    let Some(overlay) = app.get_webview_window("program-overlay") else {
        return;
    };
    if let Some(rect) = rect {
        placement(&overlay, rect);
        let _ = window_presentation::set_overlay_visible(&overlay, true);
    } else {
        let _ = window_presentation::set_overlay_visible(&overlay, false);
    }
}

#[tauri::command]
fn restore_layout(app: tauri::AppHandle, state: tauri::State<'_, HostState>, diagnostic_operation_id: Option<String>) -> Result<(), serde_json::Value> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), serde_json::Value> = (|| {
    let layout = state
        .tracker
        .lock()
        .map_err(|error| command_log.preserve_error("restore_layout", native_operation_id.as_deref(), &error, serde_json::json!("桌面窗口状态不可用。")))?
        .restore_layout()
        .ok_or_else(|| serde_json::json!("无法读取显示器工作区。"))?;
    apply_layout(&app, layout);
    update_overlay(&app, &state);
    let tracker = state.tracker.lock().map_err(|error| command_log.preserve_error("restore_layout", native_operation_id.as_deref(), &error, serde_json::json!("桌面窗口状态不可用。")))?;
    if tracker.window.is_none() {
        return Err(serde_json::json!("工作区已恢复，尚未找到 CS2。打开游戏后再恢复布局。"));
    }
    if !tracker.managed {
        return Err(if tracker.preserve_settings {
            serde_json::json!("本次启动保留原游戏设置，未接管游戏窗口布局。请保持当前设置；需要自动布局时先正常退出本次游戏，在准备中心完成恢复后选择自动设置启动。")
        } else {
            match tracker.window_message() {
                Some(message) => serde_json::json!({"kind": "window_control", "message": message}),
                None => serde_json::json!("工作台面板已恢复，CS2 窗口对齐尚未确认。请确认游戏窗口可见后重试恢复布局。")
            }
        });
    }
    Ok(())

    })();
    diagnostic_log.native_outcome("restore_layout", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

fn focus_session(process: &managed_cs2::WorkspaceProcess) -> workspace_focus::Session {
    workspace_focus::Session { pid: process.pid, created: process.created }
}

fn attempt_game_focus(app: &tauri::AppHandle, request: workspace_focus::Request) -> bool {
    let result = (|| -> Result<(), &'static str> {
        let state = app.state::<HostState>();
        if !state.visible.load(Ordering::Acquire)
            || app.state::<production_exit::ExitGate>().check().is_err()
            || app.state::<cs2_activity::Activity>().phase() != "idle"
        { return Err("workspace_unavailable"); }
        let cs2_state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let cs2 = cs2_state.try_lock().map_err(|_| "session_busy")?;
        let process = cs2.workspace_process().map_err(|_| "session_invalid")?
            .ok_or("session_missing")?;
        if !process.is_running() { return Err("process_stopped"); }
        let tracker = state.tracker.try_lock().map_err(|_| "tracker_busy")?;
        let window = tracker.window.ok_or("game_window_missing")?;
        if window.pid != process.pid { return Err("game_window_mismatch"); }
        let mut invoked = false;
        let focused = request.attempt(focus_session(&process), windows_host::foreground(), true, |source| {
            invoked = true;
            tracker.restore_focus(source)
        });
        if focused { Ok(()) }
        else if invoked { Err("native_focus_not_acquired") }
        else { Err("intent_cancelled") }
    })();
    app.state::<DesktopLog>().event("workspace_focus_attempt",
        if result.is_ok() { "focused" } else { "not_focused" }, result.err());
    result.is_ok()
}

#[tauri::command]
fn restore_cs2_focus(window: tauri::WebviewWindow, app: tauri::AppHandle, diagnostic_operation_id: Option<String>) -> bool {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: bool = (|| {
    if !matches!(window.label(), "workspace-left" | "workspace-dock" | "tool-review") { return false; }
    let Ok(hwnd) = window.hwnd() else { return false; };
    let source = hwnd.0 as isize;
    if windows_host::foreground() != source { return false; }
    let request = {
        let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let Ok(cs2) = managed.try_lock() else { return false; };
        let Ok(Some(process)) = cs2.workspace_process() else { return false; };
        workspace_focus::Request::new(focus_session(&process), source)
    };
    request.is_some_and(|request| attempt_game_focus(&app, request))

    })();
    diagnostic_log.native_outcome("restore_cs2_focus", diagnostic_operation_id.as_deref(), &Ok::<bool, String>(diagnostic_result));
    diagnostic_result
}

#[tauri::command]
fn set_program_overlay_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    enabled: bool,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
    state
        .tracker
        .lock()
        .map_err(|error| command_log.preserve_error("set_program_overlay_enabled", native_operation_id.as_deref(), &error, "桌面窗口状态不可用。"))?
        .overlay_enabled = enabled;
    update_overlay(&app, &state);
    Ok(())

    })();
    diagnostic_log.native_outcome("set_program_overlay_enabled", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
fn cs2_host_status(state: tauri::State<'_, HostState>) -> serde_json::Value {
    match state.tracker.lock() {
        Ok(tracker) => {
            serde_json::json!({ "found": tracker.window.is_some(), "managed": tracker.managed, "generation": tracker.generation, "geometry": tracker.geometry_diagnostics(), "message": tracker.window_message() })
        }
        Err(_) => serde_json::json!({ "found": false, "managed": false, "generation": 0 }),
    }
}

#[tauri::command]
async fn select_obs_executable(app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<Option<String>, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<Option<String>, String> = async move {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("OBS Studio", &["exe"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| command_log.preserve_error("select_obs_executable", native_operation_id.as_deref(), &error, "文件选择器未能打开。".to_string()))?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|error| command_log.preserve_error("select_obs_executable", native_operation_id.as_deref(), &error, "无法读取所选文件路径。".to_string()))?;
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| !name.eq_ignore_ascii_case("obs64.exe"))
        || !path.is_file()
    {
        return Err("请选择 OBS Studio 的 obs64.exe。".into());
    }
    Ok(Some(path.to_string_lossy().into_owned()))

    }.await;
    diagnostic_log.native_outcome("select_obs_executable", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

fn local_url(path: &str) -> WebviewUrl {
    WebviewUrl::External(format!("{BASE}{path}").parse().expect("fixed local URL"))
}

fn obs_executable_allowed(path: &Path) -> bool {
    path.is_absolute()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("obs64.exe"))
}

#[tauri::command]
async fn launch_obs(
    executable_path: String,
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<bool, String> = async move {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        obs_configuration::launch(&executable_path, None, &log)
    })
    .await
    .map_err(|error| command_log.preserve_error("launch_obs", native_operation_id.as_deref(), &error, "OBS 程序未能打开。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("launch_obs", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn begin_obs_configuration(
    executable_path: String,
    session_id: String,
    document_generation: String,
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<bool, String> = async move {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        obs_configuration::launch(&executable_path, Some((&session_id, &document_generation)), &log)
    })
    .await
    .map_err(|error| command_log.preserve_error("begin_obs_configuration", native_operation_id.as_deref(), &error, "OBS 程序未能打开。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("begin_obs_configuration", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn finish_obs_configuration(
    session_id: String,
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<serde_json::Value, String> = async move {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || obs_configuration::finish(&session_id, &log))
        .await
        .map_err(|error| command_log.preserve_error("finish_obs_configuration", native_operation_id.as_deref(), &error, "OBS 配置状态未能确认，请在 OBS 中手动核对。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("finish_obs_configuration", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn read_obs_configuration_context(log: tauri::State<'_, DesktopLog>) -> Result<serde_json::Value, String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || obs_configuration::context(&log))
        .await.map_err(|_| "OBS 配置状态未能确认。".to_string())?
}

#[tauri::command]
async fn cs2_config_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let result = match state.try_lock() {
            Ok(cs2) => cs2.status(),
            Err(std::sync::TryLockError::WouldBlock) => Ok(serde_json::json!({
                "busy": true, "phase": app.state::<cs2_activity::Activity>().phase()
            })),
            Err(_) => Err("CS2 配置状态不可用。".into()),
        };
        result.map(|mut value| {
            value["observerHudPending"] = observer_hud::pending(&app.state::<DesktopLog>()).into();
            value
        })
    })
    .await
    .map_err(|_| "CS2 配置状态不可用。".to_string())?
}

#[tauri::command]
async fn launch_mulnx(window: tauri::WebviewWindow, app: tauri::AppHandle,
    automatic: Option<bool>, preserve_settings: Option<bool>, resume_only: Option<bool>, diagnostic_operation_id: Option<String>) -> Result<serde_json::Value, String> {
    if window.label() != "main" { return Err("请在准备中心打开 MulNX。".into()); }
    let log = app.state::<DesktopLog>().inner().clone();
    let evidence = log.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if resume_only.unwrap_or(false) { mulnx_launch::resume(&app, &log) }
        else { mulnx_launch::launch(&app, &log, automatic.unwrap_or(true), preserve_settings.unwrap_or(false)) }
    })
        .await.unwrap_or_else(|error| Err(format!("MulNX 启动任务失败：{error}")));
    evidence.native_outcome("launch_mulnx", diagnostic_operation_id.as_deref(), &result);
    result
}

#[tauri::command]
async fn mulnx_control(window: tauri::WebviewWindow, app: tauri::AppHandle,
    action: String, diagnostic_operation_id: Option<String>) -> Result<serde_json::Value, String> {
    if window.label() != "main" { return Err("请在准备中心管理 MulNX。".into()); }
    let log = app.state::<DesktopLog>().inner().clone();
    let evidence = log.clone();
    log.event("mulnx_control", "begin", Some(&format!("action={action}")));
    let result = tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "update" => mulnx_launch::update(&app, &log),
        "stop" => mulnx_launch::stop_control(&app, &log),
        _ => Err("请选择更新或停止 MulNX 控制。".into()),
    }).await.unwrap_or_else(|error| Err(format!("MulNX 操作失败：{error}")));
    evidence.native_outcome("mulnx_control", diagnostic_operation_id.as_deref(), &result);
    result
}

#[tauri::command]
async fn mulnx_handoff_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let result = state.try_lock().map_err(|_| "CS2 正忙，请稍后检查。".to_string())?
            .mulnx_handoff_status();
        result
    }).await.map_err(|_| "无法读取 CS2 进程身份。".to_string())?
}

#[tauri::command]
fn open_mulnx_browser(log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{BASE}/\0").encode_utf16().collect();
    let result = unsafe { ShellExecuteW(0, operation.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    let outcome = if result <= 32 { Err("浏览器未能打开，请访问 http://127.0.0.1:3000/ 。".into()) } else { Ok(()) };
    log.native_outcome("open_mulnx_browser", diagnostic_operation_id.as_deref(), &outcome);
    outcome
}

#[tauri::command]
async fn attach_external_cs2(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    pid: u32,
    created: String,
    expected_revision: String,
    demo_trial: Option<bool>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<bool, String> {
    if window.label() != "main" { return Err("请在准备中心选择外部游戏。".into()); }
    let log = app.state::<DesktopLog>().inner().clone();
    let evidence_log = log.clone();
    let task = diagnostic_task_id.clone();
    let operation = diagnostic_operation_id.clone();
    let trigger = diagnostic_trigger.clone();
    let result = tauri::async_runtime::spawn_blocking(move || log.with_task(task.as_deref(), operation.as_deref(), trigger.as_deref(), || {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(3);
        // Same read-only selected-installation discovery as GSI; never accept an executable path from the UI.
        let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
        let gsi = powershell::parse(&log, "外部游戏安装位置核对", &output)?;
        if gsi["detected"] != true || gsi["installed"] != true || gsi["conflict"] != false || gsi["readFailed"] != false {
            return Err("请先完成所选 CS2 的 GSI 配置，再重新检查外部游戏。".into());
        }
        let cfg = PathBuf::from(gsi["cfgPath"].as_str().ok_or("CS2 安装位置未确认。")?);
        let executable = cfg.parent().and_then(Path::parent).and_then(Path::parent)
            .ok_or("CS2 安装位置无效。")?.join("bin").join("win64").join("cs2.exe");
        let created = created.parse::<u64>().map_err(|_| "游戏创建标识无效。")?;
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        production_exit::prepare_external_entry(&log, &expected_revision)?;
        cs2.attach_external(pid, created, &executable)?;
        let trial_id = if demo_trial == Some(true) {
            let id = demo_test::new_request_id(&log)?;
            demo_test::begin_external(&log, &id)?;
            Some(id)
        } else { None };
        let lease = production_exit::camera_session(&log, "host-start", None, None)
            .and_then(|_| production_exit::camera_session(&log,
                if trial_id.is_some() { "begin-demo" } else { "begin" }, None,
                Some(trial_id.as_deref().unwrap_or(&expected_revision))))
            .and_then(|value| value["lease"].as_str().map(str::to_owned).ok_or("原生运镜会话未确认。".into()));
        match lease {
            Ok(lease) => cs2.bind_external_camera(lease),
            Err(error) => { cs2.invalidate_external(); return Err(error); }
        }
          if let Some(id) = &trial_id { cs2.bind_external_demo(id.clone()); }
        if let Ok(mut tracker) = app.state::<HostState>().tracker.lock() {
            tracker.preserve_settings = true;
        }
        if let Some(id) = trial_id {
            demo_test::request(&log, "playing", &id, None)?;
            drop(cs2);
              // Presentation requires an idle host operation. The verified
              // attachment and lease are committed before opening its windows.
              drop(_activity);
            present_production_inner(&app, true)?;
        }
        Ok(false) // No game was launched or acquired as an owned process.
    })).await.map_err(|_| "外部游戏交接未完成，请重新检查实例。".to_string())?;
    evidence_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || evidence_log.native_outcome("attach_external_cs2", diagnostic_operation_id.as_deref(), &result));
    result
}

#[tauri::command]
async fn start_managed_cs2(
    app: tauri::AppHandle,
    preserve_settings: Option<bool>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<bool, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<bool, String> = async move {
    app.state::<production_exit::ExitGate>().check()?;
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|error| command_log.preserve_error("start_managed_cs2", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(1);
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        production_exit::invalidate_local_match_exit(&app.state::<DesktopLog>())?;
        let result = if preserve_settings.unwrap_or(false) {
            cs2.start_with_settings(true)
        } else {
            cs2.start()
        };
        if let Ok(mut tracker) = app.state::<HostState>().tracker.lock() {
            tracker.preserve_settings = cs2.preserve_settings();
        }
        result
        })
    } })
    .await
    .map_err(|error| command_log.preserve_error("start_managed_cs2", native_operation_id.as_deref(), &error, "CS2 启动未完成。".to_string()))?

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("start_managed_cs2", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

#[tauri::command]
async fn begin_managed_camera(window: tauri::WebviewWindow, app: tauri::AppHandle, expected_revision: String) -> Result<(), String> {
    if window.label() != "main" { return Err("请在准备中心打开工作台。".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
        let game = cs2.workspace_process()?.filter(|game| game.owned && game.is_running())
            .ok_or("请先确认受管 CS2 已启动。")?;
        let actual = cs2.mulnx_handoff_status()?;
        let unique = actual["processes"].as_array().is_some_and(|processes| {
            processes.len() == 1 && processes[0]["pid"] == game.pid
                && processes[0]["created"].as_str() == Some(game.created.to_string().as_str())
                && processes[0]["managed"] == true
        });
        if !unique { return Err("受管游戏身份不唯一，未建立运镜会话。".into()); }
        let log = app.state::<DesktopLog>();
        let value = production_exit::camera_session(&log, "begin", None, Some(&expected_revision))?;
        let lease = value["lease"].as_str().ok_or("原生运镜会话未确认。")?.to_owned();
        if let Err(error) = cs2.bind_managed_camera(game, lease.clone()) {
            let _ = production_exit::camera_session(&log, "invalidate", Some(&lease), None);
            return Err(error);
        }
        Ok(())
    }).await.map_err(|_| "受管运镜会话未能准备。".to_string())?
}

#[tauri::command]
async fn cancel_managed_camera(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" { return Err("请在准备中心取消进入工作台。".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
        if let Some((lease, _)) = cs2.managed_camera_lease() {
            cs2.invalidate_managed_camera();
            production_exit::camera_session(&app.state::<DesktopLog>(), "invalidate", Some(&lease), None)?;
            cs2.clear_managed_camera();
        }
        Ok(())
    }).await.map_err(|_| "受管运镜会话未能取消。".to_string())?
}

fn refresh_finished_window_feedback(app: &tauri::AppHandle, cs2: &managed_cs2::ManagedCs2) {
    let log = app.state::<DesktopLog>();
    log.event("workspace_exit_feedback", "begin", None);
    // Optional feedback retirement cannot be used as proof of game/production cleanup.
    let result = app.state::<HostState>().tracker.lock()
        .map_err(|_| "窗口反馈状态锁不可用。".to_owned())
        .and_then(|mut tracker| tracker.finish_session_feedback(cs2));
    match result {
        Ok(retired) => log.event("workspace_exit_feedback", if retired { "success" } else { "skipped" }, Some(&serde_json::json!({"retired":retired,"reason":if retired {"finished"} else {"no_feedback_or_no_stop_proof"}}).to_string())),
        Err(error) => log.event("workspace_exit_feedback", "failure", Some(&error)),
    }
}

#[tauri::command]
async fn finish_managed_cs2(app: tauri::AppHandle, diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<(), String> = async move {
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|error| command_log.preserve_error("finish_managed_cs2", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(2);
        if cs2.has_external() { return Err("请使用退出工作台解除借用；外部游戏由原启动方退出。".into()); }
        production_exit::finish_managed_game(&app.state::<DesktopLog>(), |requires_proof| {
            cs2.finish()?;
            if requires_proof {
                cs2.confirm_game_stopped()?;
            }
            Ok(())
        })?;
        refresh_finished_window_feedback(&app, &cs2);
        Ok(())
        })
    } })
    .await
    .map_err(|error| command_log.preserve_error("finish_managed_cs2", native_operation_id.as_deref(), &error, "CS2 原配置恢复未完成。".to_string()))?

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("finish_managed_cs2", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

#[tauri::command]
fn workspace_exit_status(app: tauri::AppHandle) -> serde_json::Value {
    let state = app.state::<production_exit::WorkspaceExit>().status();
    let window_message = app.state::<HostState>().tracker.lock().ok().and_then(|tracker| tracker.window_message());
    serde_json::json!({ "busy": state.busy, "stage": state.stage, "message": state.message, "windowMessage": window_message })
}

#[tauri::command]
async fn finish_workspace(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    confirm_steam_cancelled: Option<bool>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<(), String> = async move {
    if !["main", "workspace-left", "workspace-dock"].contains(&window.label()) {
        return Err("请在准备中心或工作台退出本次制作。".into());
    }
    let gate = app.state::<production_exit::ExitGate>();
    if !gate.begin() {
        return Err("正在退出，请等待收尾结果。".into());
    }
    let _gate = production_exit::WorkspaceExitGuard(&gate);
    let feedback = app.state::<production_exit::WorkspaceExit>();
    feedback.stage("checking");
    command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || app.state::<DesktopLog>().event("workspace_exit", "begin", Some(&serde_json::json!({"phase":"checking", "confirmSteamCancelled":confirm_steam_cancelled}).to_string())));
    // Keep a visible waiting record if a native lock, process or presentation call stalls.
    let (waiting_done, waiting) = std::sync::mpsc::channel::<()>();
    let waiting_host = app.clone();
    let waiting_log = command_log.clone();
    let waiting_task = native_task_id.clone();
    let waiting_trigger = native_trigger.clone();
    let waiting_operation = native_operation_id.clone();
    std::thread::spawn(move || waiting_log.with_task(waiting_task.as_deref(), waiting_operation.as_deref(), waiting_trigger.as_deref(), || {
        let started = std::time::Instant::now();
        while waiting.recv_timeout(Duration::from_secs(5)) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            let phase = waiting_host.state::<production_exit::WorkspaceExit>().status().stage;
            waiting_host.state::<DesktopLog>().event("workspace_exit", "waiting", Some(&serde_json::json!({"phase":phase,"elapsedMs":started.elapsed().as_millis()}).to_string()));
        }
    }));
    // This task belongs to Host, so hiding or closing a WebView cannot lose it.
    let host = app.clone();
    let result = tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || -> Result<(), String> {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        let feedback = host.state::<production_exit::WorkspaceExit>();
        let log = host.state::<DesktopLog>();
        let managed = host.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = log.step("workspace_exit_lock", || managed.lock().map_err(|error| command_log.preserve_error("finish_workspace", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。")))?;
        let activity = host.state::<cs2_activity::Activity>();
        // Open the visible recovery owner before any potentially slow cleanup.
        // A presentation failure cannot skip safe production or game cleanup.
        if let Err(error) = open_main(host.clone(), None, None) {
            log.event(
                "production_finish",
                "failure",
                Some(&format!("phase=workspace_recovery_window; cause={error}")),
            );
        }
        feedback.stage("production");
        log.step("workspace_exit_production", || production_exit::finish_workspace_production(&log))?;
        let game = production_exit::restore_then_cleanup(
        || log.step("workspace_exit_observer", || observer_workspace::finish(&log)),
        || -> Result<(), String> {
        let trial = log.step("workspace_exit_trial_status", || demo_test::status(&log))?;
        if trial["active"] == true || cs2.has_demo_journal()? {
            feedback.stage("restoration");
            let _activity = activity.begin(2);
            if confirm_steam_cancelled == Some(true) {
                log.step("workspace_exit_restore_backup", || cs2.restore_backup(true))?;
            }
            log.step("workspace_exit_game_finish", || cs2.finish())?;
        } else if cs2.has_external() {
            feedback.stage("detachment");
            let _activity = activity.begin(3);
            // Production has safely finished. Detach without granting game-stop/recycle proof.
            log.step("workspace_external_detach", || cs2.finish())?;
        } else {
            feedback.stage("restoration");
            let _activity = activity.begin(2);
            production_exit::finish_managed_game(&log, |requires_proof| {
                if confirm_steam_cancelled == Some(true) {
                    log.step("workspace_exit_restore_backup", || cs2.restore_backup(true))?;
                }
                log.step("workspace_exit_game_finish", || cs2.finish())?;
                if requires_proof {
                    log.step("workspace_exit_stop_proof", || cs2.confirm_game_stopped())?;
                }
                Ok(())
            })?;
        }
        Ok(())
        });
        refresh_finished_window_feedback(&host, &cs2);
        drop(cs2);
        feedback.stage("presentation");
        // Retry presentation after cleanup; an earlier transient window failure
        // must not prevent returning to preparation once the game is finished.
        let presentation = log.step("workspace_exit_presentation", || present_production_inner(&host, false));
        production_exit::cleanup_results(game, presentation)
        })
    } })
    .await
    .unwrap_or_else(|error| {
        app.state::<DesktopLog>().event(
            "production_finish",
            "failure",
            Some(&format!("phase=workspace_task; cause={error}")),
        );
        Err("退出任务中断，收尾结果待确认。请重试退出；再次失败时导出诊断。".into())
    });
    if let Err(error) = &result {
        app.state::<DesktopLog>().event(
            "production_finish",
            "failure",
            Some(&format!(
                "phase=workspace_{}; cause={error}",
                feedback.status().stage
            )),
        );
    }
    command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || app.state::<DesktopLog>().event("workspace_exit", if result.is_ok() { "success" } else { "failure" }, Some(&serde_json::json!({"phase":feedback.status().stage,"error":result.as_ref().err()}).to_string())));
    let _ = waiting_done.send(());
    feedback.complete(&result);
    if result.is_err() {
        // Keep the original local failure; never replace it with window errors.
        let _ = open_main(app.clone(), None, None);
        if let Err(window_error) = open_tool(app.clone(), "review".into(), Some("exit".into()), None).await {
            command_log.event("workspace_exit_alert", "failure", Some(&window_error));
        }
    }
    // Preserve the command result too; callers must not announce false success.
    result

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("finish_workspace", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

fn demo_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在制作中心操作 Demo 试播。".into());
    }
    Ok(())
}

#[tauri::command]
async fn select_demo_file(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<Option<serde_json::Value>, String> = async move {
    demo_main_window(&window)?;
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("CS2 Demo", &["dem"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|error| command_log.preserve_error("select_demo_file", native_operation_id.as_deref(), &error, "无法读取所选 Demo 路径。"))?;
        let selection = app.state::<Mutex<demo_test::Selection>>();
        let mut selection = selection.lock().map_err(|error| command_log.preserve_error("select_demo_file", native_operation_id.as_deref(), &error, "Demo 选择状态不可用。"))?;
        selection
            .select(&path, &app.state::<DesktopLog>())
            .map(Some)
    } })
    .await
    .map_err(|error| command_log.preserve_error("select_demo_file", native_operation_id.as_deref(), &error, "Demo 文件选择未完成。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("select_demo_file", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn start_demo_test(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    token: String,
    team_a_name: String,
    team_b_name: String,
    preserve_settings: Option<bool>,
    camera_trial: Option<bool>,
    diagnostic_operation_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<serde_json::Value, String> = async move {
    demo_main_window(&window)?;
    app.state::<production_exit::ExitGate>().check()?;
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = managed.lock().map_err(|error| command_log.preserve_error("start_demo_test", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(1);
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let path = app
            .state::<Mutex<demo_test::Selection>>()
            .lock()
            .map_err(|error| command_log.preserve_error("start_demo_test", native_operation_id.as_deref(), &error, "Demo 选择状态不可用。"))?
            .resolve(&token, &app.state::<DesktopLog>())?;
        cs2.ensure_demo_available()?;
        let log = app.state::<DesktopLog>();
        let launch_guard = if camera_trial.unwrap_or(false) {
            let guard = mulnx_launch::demo_launch_guard()?;
            if log.state_root.join("data/mulnx-launch/pending.json").exists() || cs2.mulnx_launcher_running()? {
                return Err("请先完成上次 MulNX 启动的恢复。".into());
            }
            Some(guard)
        } else { None };
        let id = demo_test::new_request_id(&log)?;
        let starting = demo_test::request(&log, "begin", &id, Some((&team_a_name, &team_b_name)))?;
        if camera_trial.unwrap_or(false) {
            drop(cs2);
            let result = mulnx_launch::launch_demo(&app, &log, &path, &id, preserve_settings.unwrap_or(false), launch_guard.as_ref().unwrap());
            let mut cs2 = managed.lock().map_err(|_| "CS2 状态不可用，请恢复试播。")?;
            return match result {
                Ok(_) => {
                    if let Ok(mut tracker) = app.state::<HostState>().tracker.lock() {
                        tracker.preserve_settings = cs2.preserve_settings();
                    }
                    Ok(starting)
                }
                Err(error) => {
                    if !cs2.demo_launch_attempted()? {
                        if let Err(recovery) = cs2.cancel_unsubmitted_mulnx_demo() {
                            return Err(format!("{error}；恢复未完成：{recovery}"));
                        }
                    }
                    Err(error)
                }
            };
        }
        match cs2.start_demo(&path, &id, preserve_settings.unwrap_or(false)) {
            Ok(true) => {
                if let Ok(mut tracker) = app.state::<HostState>().tracker.lock() {
                    tracker.preserve_settings = cs2.preserve_settings();
                }
                Ok(starting)
            }
            Ok(false) => Err("Demo 启动请求未提交，请结束试播后重试。".into()),
            Err(error) => {
                // A durable attempted launch can still arrive late through
                // Steam. Only a proven pre-launch failure permits cancel.
                if !cs2.demo_launch_attempted()? {
                    demo_test::request(&log, "cancel", &id, None)?;
                    cs2.recover(false)?;
                }
                Err(error)
            }
        }
    } })
    .await
    .map_err(|error| command_log.preserve_error("start_demo_test", native_operation_id.as_deref(), &error, "Demo 试播启动未完成。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("start_demo_test", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn resume_demo_test(window: tauri::WebviewWindow, app: tauri::AppHandle, request_id: String) -> Result<serde_json::Value, String> {
    demo_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let log = app.state::<DesktopLog>();
        mulnx_launch::resume_demo(&app, &log, &request_id)
    }).await.map_err(|_| "Demo 启动状态未能确认。".to_string())?
}

#[tauri::command]
async fn enter_demo_test(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<bool, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<bool, String> = async move {
    demo_main_window(&window)?;
    let host = app.clone();
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        let managed = host.state::<Mutex<managed_cs2::ManagedCs2>>();
        let log = host.state::<DesktopLog>();
        mulnx_launch::resume_demo(&host, &log, &request_id)?;
        let mut cs2 = managed.lock().map_err(|error| command_log.preserve_error("enter_demo_test", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        host.state::<production_exit::ExitGate>().check()?;
        host.state::<updates::PendingUpdate>().check()?;
        cs2.validate_demo_running(&request_id)?;
        let log = host.state::<DesktopLog>();
        let camera_trial = cs2.console_source()?.is_some_and(|(context, game)| game.owned && context["mulnxLaunch"] == true);
        if camera_trial && cs2.managed_camera_lease().is_none() {
            if !mulnx_launch::observer_control_available(&cs2, &log) {
                return Err("运镜工具尚未就绪，请检查试播游戏状态。".into());
            }
            let game = cs2.workspace_process()?.filter(|game| game.owned && game.is_running())
                .ok_or("试播游戏身份已变化。")?;
            let value = production_exit::camera_session(&log, "begin-demo", None, Some(&request_id))?;
            let lease = value["lease"].as_str().ok_or("运镜会话未确认。")?.to_owned();
            if let Err(error) = cs2.bind_managed_camera(game, lease.clone()) {
                let _ = production_exit::camera_session(&log, "invalidate", Some(&lease), None);
                return Err(error);
            }
        }
        demo_test::request(&log, "playing", &request_id, None)?;
        drop(cs2);
        Ok(camera_trial)
        })
    } })
    .await
    .map_err(|error| command_log.preserve_error("enter_demo_test", native_operation_id.as_deref(), &error, "Demo 工作台未能打开。".to_string()))?

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("enter_demo_test", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

#[derive(Default)]
struct DemoEntryIntent(Mutex<Option<String>>);
impl DemoEntryIntent {
    fn begin(&self, id: String) -> Result<(), String> {
        *self.0.lock().map_err(|_| "试播进入状态不可用。")? = Some(id);
        Ok(())
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "试播进入状态不可用。")?;
        if current.as_deref() == Some(id) { *current = None; }
        Ok(())
    }
    fn cancel_all(&self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
    fn publish(&self, id: &str, valid_page: impl FnOnce() -> bool, show: impl FnOnce()) -> bool {
        let mut current = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if current.as_deref() != Some(id) || !valid_page() { return false; }
        *current = None;
        show();
        true
    }
}

#[tauri::command]
fn begin_demo_entry(window: tauri::WebviewWindow, app: tauri::AppHandle, intent_id: String) -> Result<(), String> {
    demo_main_window(&window)?;
    if intent_id.len() != 36 || !intent_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("试播进入请求无效。".into());
    }
    app.state::<DemoEntryIntent>().begin(intent_id)
}

#[tauri::command]
fn cancel_demo_entry(window: tauri::WebviewWindow, app: tauri::AppHandle, intent_id: String) -> Result<(), String> {
    demo_main_window(&window)?;
    app.state::<DemoEntryIntent>().cancel(&intent_id)
}

#[tauri::command]
async fn present_demo_test(window: tauri::WebviewWindow, app: tauri::AppHandle, request_id: String, expected_url: String, intent_id: String) -> Result<(), String> {
    demo_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = demo_test::status(&app.state::<DesktopLog>())?;
        if state["active"] != true || state["phase"] != "playing" || state["requestId"].as_str() != Some(&request_id) {
            return Err("试播状态已变化，请重新进入。".into());
        }
        present_production_inner_checked(&app, true, Some((expected_url, intent_id)))
    }).await.map_err(|_| "试播工作台未能打开。".to_string())?
}

#[tauri::command]
async fn finish_demo_test(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: Option<String>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<(), String> = async move {
    if !["main", "workspace-left", "workspace-dock"].contains(&window.label()) {
        return Err("请在制作中心或试播工作台结束 Demo 试播。".into());
    }
    let host = app.clone();
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        host.state::<DemoEntryIntent>().cancel_all();
        let managed = host.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = managed.lock().map_err(|error| command_log.preserve_error("finish_demo_test", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        let activity = host.state::<cs2_activity::Activity>();
        let _activity = activity.begin(2);
        let state = demo_test::status(&host.state::<DesktopLog>())?;
        if state["active"] != true && !cs2.has_demo_journal()? {
            // A retry after completion must not finish a later normal game.
            return Ok(());
        }
        // Recovery may replace a corrupt marker's UUID. The fresh Companion
        // identity controls completion; native process ownership controls exit.
        if state["active"] == true
            && state["phase"] != "recovery"
            && request_id
                .as_deref()
                .is_some_and(|id| state["requestId"].as_str() != Some(id))
        {
            return Err("Demo 试播状态已变化，请刷新后重试。".into());
        }
        cs2.finish()?;
        refresh_finished_window_feedback(&host, &cs2);
        present_production_inner(&host, false)
        })
    } })
    .await
    .map_err(|error| command_log.preserve_error("finish_demo_test", native_operation_id.as_deref(), &error, "Demo 试播恢复未完成。".to_string()))??;
    Ok(())

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("finish_demo_test", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

async fn console_settings_request(
    app: tauri::AppHandle, enabled: Option<bool>, expected_generation: Option<String>,
    diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>,
) -> Result<serde_json::Value, String> {
    let command = if enabled.is_some() { "set_cs2_console_capture" } else { "cs2_console_status" };
    let log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_log = log.clone();
    let join_operation = diagnostic_operation_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || {
            let result = (|| {
                if let Some(enabled) = enabled { cs2_console::set_enabled(&log, enabled, expected_generation.as_deref())?; }
                cs2_console::status(&log)
            })();
            log.native_outcome(command, diagnostic_operation_id.as_deref(), &result);
            result
        })
    }).await.map_err(|error| diagnostic_log.preserve_error(command, join_operation.as_deref(), &error, "技术日志设置未能完成，请重试。".to_string()))?
}
#[tauri::command]
async fn cs2_console_status(app: tauri::AppHandle, diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> Result<serde_json::Value, String> {
    console_settings_request(app, None, None, diagnostic_operation_id, diagnostic_task_id, diagnostic_trigger).await
}
#[tauri::command]
async fn set_cs2_console_capture(app: tauri::AppHandle, enabled: bool, expected_generation: Option<String>, diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> Result<serde_json::Value, String> {
    console_settings_request(app, Some(enabled), expected_generation, diagnostic_operation_id, diagnostic_task_id, diagnostic_trigger).await
}

#[tauri::command]
async fn set_cs2_preferences(
    app: tauri::AppHandle,
    quality_preset: String,
    frame_rate_limit: u16,
    prefer_mulnx: Option<bool>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = async move {
    let mut preferences = cs2_preferences::Preferences::new(&quality_preset, frame_rate_limit)?;
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|error| command_log.preserve_error("set_cs2_preferences", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(3);
        preferences.prefer_mulnx = prefer_mulnx.unwrap_or(cs2.status()?["preferMulnx"].as_bool().unwrap_or(false));
        cs2.preferences(preferences)
    } })
    .await
    .map_err(|error| command_log.preserve_error("set_cs2_preferences", native_operation_id.as_deref(), &error, "CS2 启动设置未保存。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("set_cs2_preferences", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn restore_cs2_backup(
    app: tauri::AppHandle,
    confirm_steam_cancelled: bool,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<(), String> = async move {
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|error| command_log.preserve_error("restore_cs2_backup", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(2);
        cs2.restore_backup(confirm_steam_cancelled)?;
        refresh_finished_window_feedback(&app, &cs2);
        Ok(())
        })
    } })
    .await
    .map_err(|error| command_log.preserve_error("restore_cs2_backup", native_operation_id.as_deref(), &error, "CS2 原配置恢复未完成。".to_string()))?

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("restore_cs2_backup", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

#[tauri::command]
async fn manage_cs2_backup(
    window: tauri::WebviewWindow, app: tauri::AppHandle, action: String,
    selection_id: Option<String>, diagnostic_operation_id: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" { return Err("请在制作中心恢复游戏设置。".into()); }
    let log = app.state::<DesktopLog>().inner().clone();
    let command_log = log.clone();
    let operation = diagnostic_operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        if action == "select" {
            // Retire prior approval before opening the modal native chooser.
            state.lock().map_err(|_| "恢复状态不可用。")?.cancel_selected_backup();
            let Some(file) = app.dialog().file().add_filter("CS2 配置备份", &["txt", "bak"]).blocking_pick_file() else { return Ok(None); };
            let path = file.into_path().map_err(|e| command_log.preserve_error("manage_cs2_backup",operation.as_deref(),&e,"备份路径无法读取。"))?;
            app.state::<production_exit::ExitGate>().check()?;
            app.state::<updates::PendingUpdate>().check()?;
            return state.lock().map_err(|_| "恢复状态不可用。")?.select_backup(&path).map(Some);
        }
        let mut cs2 = state.lock().map_err(|_| "恢复状态不可用。")?;
        match action.as_str() {
            "cancel" => cs2.cancel_selected_backup(),
            "apply" => {
                let activity = app.state::<cs2_activity::Activity>();
                let _activity = activity.begin(2);
                cs2.apply_selected_backup(selection_id.as_deref().ok_or("请先核对备份。")?)?;
            }
            _ => return Err("备份操作无效。".into()),
        }
        Ok(None)
    }).await.map_err(|e| log.preserve_error("manage_cs2_backup",diagnostic_operation_id.as_deref(),&e,"备份操作未完成。"))?;
    // The full selected file stays inside Host. Log the operation outcome rather
    // than duplicating avatar image bytes in the native diagnostic stream.
    log.native_outcome("manage_cs2_backup",diagnostic_operation_id.as_deref(), &result.as_ref().map(|_| ()));
    result
}

#[tauri::command]
async fn open_cs2_backup(app: tauri::AppHandle, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = async move {
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let path = app
            .state::<Mutex<managed_cs2::ManagedCs2>>()
            .lock()
            .map_err(|error| command_log.preserve_error("open_cs2_backup", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?
            .backup_directory();
        fs::create_dir_all(&path).map_err(|error| command_log.preserve_error("open_cs2_backup", native_operation_id.as_deref(), &error, "备份目录无法打开。"))?;
        let executable =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?)
                .join("explorer.exe");
        Command::new(executable)
            .arg(path)
            .spawn()
            .map_err(|error| command_log.preserve_error("open_cs2_backup", native_operation_id.as_deref(), &error, "备份目录无法打开。"))?;
        Ok(())
    } })
    .await
    .map_err(|error| command_log.preserve_error("open_cs2_backup", native_operation_id.as_deref(), &error, "备份目录无法打开。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("open_cs2_backup", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

fn trusted_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(3000)
}

fn show_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.visible.store(true, Ordering::Relaxed);
    sync_workspace_shell(app);
    // Native window calls can synchronously dispatch window events. Release
    // the tracker before presenting any WebView or posting HUD visibility.
    let layout = state
        .tracker
        .lock()
        .ok()
        .and_then(|mut tracker| tracker.restore_layout());
    if let Some(layout) = layout {
        apply_layout(app, layout);
    }
    for label in ["workspace-left", "workspace-dock"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window_presentation::show_without_activation(&window);
        }
    }
    update_overlay(app, &state);
}

fn hide_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    state.visible.store(false, Ordering::Relaxed);
    if let Ok(mut group) = state.window_group.lock() {
        *group = workspace_group::Group::default();
    }
    sync_workspace_shell(app);
    let result = window_presentation::hide_panels(|label| {
        let Some(window) = app.get_webview_window(label) else { return Ok(()); };
        window_presentation::hide_without_activation(&window).map_err(|error| {
            app.state::<DesktopLog>().event(
                "production_finish", "failure",
                Some(&format!("phase=workspace_hide_panel; label={label}; cause={error}")),
            );
            let title = if label == "workspace-left" { "现场工作区" } else { "现场控制底栏" };
            format!("{title}未能隐藏，请在准备中心重试退出工作台。")
        })
    });
    if let Some(review) = app.get_webview_window("tool-review") { let _ = review.destroy(); }
    present_overlay(app, None);
    result
}

fn main_path_allowed(path: &str) -> bool {
    [
        "/",
        "/matches",
        "/resources",
        "/matches?tab=roster",
        "/matches?tab=maps",
        "/matches#match-bp",
        "/picture",
        "/picture?tab=overlay",
        "/settings",
        "/settings?tab=gsi",
        "/settings?tab=obs",
        "/settings?tab=music",
        "/settings?tab=camera",
        "/settings?tab=music&section=camera",
        "/settings?tab=rivalhub",
    ]
    .contains(&path)
}

#[tauri::command]
fn open_main(app: tauri::AppHandle, path: Option<String>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
    let path = path.unwrap_or_else(|| "/".into());
    if !main_path_allowed(&path) {
        return Err("页面无法识别。".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("准备中心窗口不可用，请通过托盘退出后重新打开 Mizar。")?;
    window
        .navigate(
            format!("{BASE}{path}")
                .parse()
                .map_err(|error| command_log.preserve_error("open_main", native_operation_id.as_deref(), &error, "页面无法识别。"))?,
        )
        .map_err(|error| command_log.preserve_error("open_main", native_operation_id.as_deref(), &error, "无法打开 Mizar。"))?;
    window
        .unminimize()
        .map_err(|error| command_log.preserve_error("open_main", native_operation_id.as_deref(), &error, "准备中心窗口未能恢复，请重试。"))?;
    window_presentation::set_visible(&window, true)
        .map_err(|error| command_log.preserve_error("open_main", native_operation_id.as_deref(), &error, "准备中心窗口未能显示，请重试。"))?;
    let _ = window.set_focus();
    Ok(())

    })();
    diagnostic_log.native_outcome("open_main", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn present_production(app: tauri::AppHandle, live: bool, diagnostic_operation_id: Option<String>, diagnostic_task_id: Option<String>, diagnostic_trigger: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<(), String> = async move {
    tauri::async_runtime::spawn_blocking({ let log = command_log.clone(); let operation = native_operation_id.clone(); move || log.with_task(native_task_id.as_deref(), operation.as_deref(), native_trigger.as_deref(), || present_production_inner(&app, live)) })
        .await.map_err(|error| command_log.preserve_error("present_production", native_operation_id.as_deref(), &error, "现场窗口未能打开。".to_string()))?

    }.await;
    diagnostic_log.with_task(diagnostic_task_id.as_deref(), diagnostic_operation_id.as_deref(), diagnostic_trigger.as_deref(), || diagnostic_log.native_outcome("present_production", diagnostic_operation_id.as_deref(), &diagnostic_result));
    diagnostic_result
}

fn present_production_inner(app: &tauri::AppHandle, live: bool) -> Result<(), String> {
    present_production_inner_checked(app, live, None)
}

fn present_production_inner_checked(app: &tauri::AppHandle, live: bool, expected_url: Option<(String, String)>) -> Result<(), String> {
    if live {
        let ticket = app.state::<production_exit::ExitGate>().presentation_ticket()?;
        // Capture before window creation/layout work. A later foreground change
        // cancels this one-shot intent; showing the panels must not select them.
        let source = app.get_webview_window("main")
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize)
            .filter(|hwnd| *hwnd == windows_host::foreground()).unwrap_or(0);
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let (mut request, process) = {
            let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let cs2 = managed.lock().map_err(|_| "CS2 配置状态不可用。")?;
            let process = cs2.workspace_process()?;
            let request = process.as_ref().filter(|process| process.owned).and_then(|process| {
                app.state::<HostState>().entry_focus.lock().ok()?
                    .request(focus_session(process), source)
            });
            (request, process)
        };
        if request.is_some() {
            let started = Instant::now();
            let mut readiness = workspace_focus::Readiness::new(source, started);
            loop {
                let eligible = process.as_ref().is_some_and(|process| process.is_running())
                    && app.state::<production_exit::ExitGate>().check().is_ok()
                    && app.state::<cs2_activity::Activity>().phase() == "idle";
                let window_ready = windows_host::find_cs2().is_some_and(|window| {
                    process.as_ref().is_some_and(|process| window.pid == process.pid)
                });
                let decision = readiness.poll(Instant::now(), windows_host::foreground(), eligible, window_ready);
                if decision == workspace_focus::ReadinessState::Waiting {
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                if decision != workspace_focus::ReadinessState::Ready { request = None; }
                app.state::<DesktopLog>().event("workspace_entry_readiness", match decision {
                    workspace_focus::ReadinessState::Ready => "ready",
                    workspace_focus::ReadinessState::TimedOut => "timed_out",
                    _ => "cancelled",
                }, Some(&format!("elapsedMs={}", started.elapsed().as_millis())));
                break;
            }
        }
        // A stop/exit can run while the render window is still loading.
        // Do not reopen a workspace whose managed game has been ended.
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        if app.state::<cs2_activity::Activity>().phase() != "idle"
            || process.as_ref().is_some_and(|process| !process.is_running())
        { return Err("游戏启动已取消或正在恢复，请完成收尾后重新进入工作台。".into()); }
        ensure_live_windows(&app).map_err(|error| {
            format!("现场窗口未能打开，准备中心仍可使用。请打开运行日志后重试。\n{error}")
        })?;
        let host = app.clone();
        let (published, completion) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            // Check and publish under the same gate on the actual UI thread.
            // An exit begun during readiness invalidates this callback even after it finishes.
            let mut valid_intent = true;
            let result = host.state::<production_exit::ExitGate>().publish(ticket, || {
                let show = || {
                    host.state::<production_exit::WorkspaceExit>().complete(&Ok(()));
                    show_workspace(&host);
                    if let Some(request) = request {
                        let focused = attempt_game_focus(&host, request);
                        host.state::<DesktopLog>().event("workspace_entry_focus",
                            if focused { "focused" } else { "not_focused" }, None);
                    }
                    if let Some(main) = host.get_webview_window("main") {
                        let _ = window_presentation::set_visible(&main, false);
                    }
                };
                if let Some((expected, id)) = &expected_url {
                    valid_intent = host.state::<DemoEntryIntent>().publish(id, || {
                        host.get_webview_window("main").is_some_and(|window| {
                            window.is_visible().ok() == Some(true)
                                && window.url().ok().is_some_and(|url| url.as_str() == expected)
                        })
                    }, show);
                } else { show(); }
            });
            let result = result.and_then(|()| if valid_intent { Ok(()) } else { Err("进入试播的页面已变化，请重新进入。".into()) });
            let _ = published.send(result);
        }).map_err(|error| error.to_string())?;
        completion.recv().map_err(|_| "现场窗口呈现未能完成，请在准备中心重新进入工作台。".to_string())??;
    } else {
        open_main(app.clone(), None, None)?;
        hide_workspace(&app)?;
    }
    Ok(())
}

fn ensure_live_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    let _guard = state
        .live_window_lock
        .lock()
        .map_err(|_| "现场窗口状态不可用。")?;
    if ["workspace-left", "workspace-dock", "program-overlay"]
        .iter()
        .all(|label| app.get_webview_window(label).is_some())
    {
        return Ok(());
    }
    let log = app.state::<DesktopLog>();
    let result = (|| {
        log.step("workspace_left", || {
            WebviewWindowBuilder::new(app, "workspace-left", local_url("/workspace/left"))
                .title("Mizar · 工作区")
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .on_navigation(trusted_navigation)
                .build()
        })?;
        log.step("workspace_dock", || {
            WebviewWindowBuilder::new(app, "workspace-dock", local_url("/workspace/dock"))
                .title("Mizar · 现场控制")
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .on_navigation(trusted_navigation)
                .build()
        })?;
        let overlay = log.step("program_overlay", || {
            WebviewWindowBuilder::new(app, "program-overlay", local_url("/program?host=desktop"))
                .title("Mizar · Program HUD")
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .transparent(true)
                .always_on_top(true)
                .focusable(false)
                .focused(false)
                .skip_taskbar(true)
                .visible(false)
                .on_navigation(trusted_navigation)
                .build()
        })?;
        let _ = window_presentation::sync_visibility(&overlay);
        log.step("overlay_cursor_passthrough", || {
            overlay.set_ignore_cursor_events(true)
        })?;
        for label in ["workspace-left", "workspace-dock", "program-overlay"] {
            if let Some(hwnd) = app
                .get_webview_window(label)
                .and_then(|window| window.hwnd().ok())
            {
                window_frame::square_window(hwnd.0 as isize);
            }
        }
        Ok(())
    })();
    if result.is_err() {
        // Creation is transactional at the host boundary. A retry starts clean;
        // Companion still owns production mode and the Main UI remains available.
        for label in ["workspace-left", "workspace-dock", "program-overlay"] {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        log.event("live_windows_rollback", "success", None);
    }
    result
}

// Review windows are centered on the workspace monitor, independently of the left panel.
fn present_review(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = app.get_webview_window("workspace-left")
        .and_then(|panel| panel.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法确定工作台所在屏幕。".to_string())?;
    let size = monitor.size();
    let origin = monitor.position();
    let scale = (size.width as f64 / 2560.0).min(size.height as f64 / 1440.0);
    let width = (1000.0 * scale).round() as u32;
    let height = (1160.0 * scale).round() as u32;
    window.set_size(tauri::PhysicalSize::new(width, height)).map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    window.set_position(tauri::PhysicalPosition::new(
        origin.x + (size.width as i32 - outer.width as i32) / 2,
        origin.y + (size.height as i32 - outer.height as i32) / 2,
    )).map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window_presentation::set_visible(window, true).map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn close_review(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "tool-review" { return Err("只能关闭当前核对窗口。".into()); }
    window.destroy().map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_tool(app: tauri::AppHandle, tool: String, preset_id: Option<String>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = async move {
    // Diagnostics must remain available while an exit is blocked or in progress.
    let exit_review = tool == "review" && preset_id.as_deref() == Some("exit");
    if exit_review && app.state::<production_exit::WorkspaceExit>().status().message.is_none() {
        return Err("当前没有待处理的退出异常。".into());
    }
    if tool != "diagnostics" && !exit_review {
        app.state::<production_exit::ExitGate>().check()?;
    }
    app.state::<updates::PendingUpdate>().check()?;
    let (label, title, path) = match tool.as_str() {
        "hud" => ("tool-hud", "HUD 工作台", "/operator/hud"),
        "bp" => ("tool-bp", "正式 BP 控制", "/operator/bp"),
        "diagnostics" => ("tool-diagnostics", "运行诊断", "/debug"),
        "review" => ("tool-review", "本场核对", "/workspace/review"),
        _ => return Err("工具无法识别。".into()),
    };
    let mut target = format!("{BASE}{path}").parse::<tauri::Url>()
        .map_err(|error| command_log.preserve_error("open_tool", native_operation_id.as_deref(), &error, "工具地址无法识别。"))?;
    if tool == "review" {
        if !exit_review && !app.state::<HostState>().visible.load(Ordering::Relaxed) { return Err("工作台已隐藏，请返回工作台后重新打开核对窗口。".into()); }
        let kind = preset_id.as_deref().unwrap_or("preflight");
        if !matches!(kind, "preflight" | "roster" | "sync" | "issues" | "exit") { return Err("核对页面无法识别。".into()); }
        target.query_pairs_mut().append_pair("kind", kind);
    }
    if tool == "hud" {
        if let Some(id) = preset_id.as_deref() {
            if id.is_empty() || id.len() > 256 { return Err("HUD 预设标识无效。".into()); }
            target.query_pairs_mut().append_pair("preset", id);
        }
    }
    if let Some(window) = app.get_webview_window(label) {
        if tool == "hud" {
            if let Some(id) = preset_id.as_deref() {
                let detail = serde_json::to_string(id)
                    .map_err(|error| command_log.preserve_error("open_tool", native_operation_id.as_deref(), &error, "HUD 预设标识无效。"))?;
                window.eval(&format!("window.dispatchEvent(new CustomEvent('mizar:hud-select-preset', {{detail:{detail}}}));"))
                    .map_err(|error| command_log.preserve_error("open_tool", native_operation_id.as_deref(), &error, "HUD 预设未能打开。"))?;
            }
        } else if tool != "review" || window.url().ok().as_ref() != Some(&target) {
            window.navigate(target.clone())
                .map_err(|error| command_log.preserve_error("open_tool", native_operation_id.as_deref(), &error, "工具窗口未能恢复。"))?;
        }
        if tool == "review" { return present_review(&app, &window); }
        let _ = window.unminimize();
        let _ = window_presentation::set_visible(&window, true);
        let _ = window.set_focus();
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(target))
        .visible(tool != "review")
        .title(format!("Mizar · {title}"))
        .inner_size(1280.0, 800.0)
        .on_navigation(trusted_navigation)
        .build()
        .map_err(|error| command_log.preserve_error("open_tool", native_operation_id.as_deref(), &error, "工具窗口未能打开。"))?;
    if tool == "review" { present_review(&app, &window)?; }
    Ok(())

    }.await;
    diagnostic_log.native_outcome("open_tool", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
fn open_steam_api_key(log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = "https://steamcommunity.com/dev/apikey\0"
        .encode_utf16()
        .collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("浏览器未能打开，请手动访问 https://steamcommunity.com/dev/apikey。".into())
    } else {
        Ok(())
    }

    })();
    diagnostic_log.native_outcome("open_steam_api_key", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
fn open_issue_report(log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> =
        "https://github.com/Starfie1d1272/Mizar/issues/new?template=bug-report.yml\0"
            .encode_utf16()
            .collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("浏览器未能打开，请手动访问 https://github.com/Starfie1d1272/Mizar/issues/new?template=bug-report.yml。".into())
    } else {
        Ok(())
    }

    })();
    diagnostic_log.native_outcome("open_issue_report", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn install_update(window: tauri::WebviewWindow, app: tauri::AppHandle, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: Result<(), String> = async move {
    if window.label() != "main" {
        return Err("请在制作中心的高级设置中确认升级。".into());
    }
    updates::prepare(app).await

    }.await;
    diagnostic_log.native_outcome("install_update", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
fn open_music_downloads(log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = "https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/?p=/Music\0".encode_utf16().collect();
    let result = unsafe { ShellExecuteW(0, operation.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    let outcome = if result <= 32 {
        Err(log.preserve_error("open_music_downloads", diagnostic_operation_id.as_deref(), &result, "音乐包下载页面未能打开，请重试。".into()))
    } else { Ok(()) };
    log.native_outcome("open_music_downloads", diagnostic_operation_id.as_deref(), &outcome);
    outcome
}

#[tauri::command]
fn open_update_page(source: String, version: Option<String>, log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
    let url = if source == "mirror" {
        "https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/?p=/Downloads".to_string()
    } else if source == "github" {
        let base = "https://github.com/Starfie1d1272/Mizar/releases";
        if let Some(version) = version {
            let parts: Vec<_> = version.split('.').collect();
            if parts.len() != 3
                || parts.iter().any(|p| {
                    p.is_empty()
                        || !p.bytes().all(|c| c.is_ascii_digit())
                        || (p.len() > 1 && p.starts_with('0'))
                })
            {
                return Err("更新版本无效。".into());
            }
            format!("{base}/tag/v{version}")
        } else {
            base.to_string()
        }
    } else {
        return Err("更新下载来源无效。".into());
    };
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("正式下载页面未能打开，请重试。".into())
    } else {
        Ok(())
    }

    })();
    diagnostic_log.native_outcome("open_update_page", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
fn open_update_recovery(app: tauri::AppHandle, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
    let log = app.state::<DesktopLog>();
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!(
        "{}\0",
        powershell::provider_path(&log.state_root.join("updates")).display()
    )
    .encode_utf16()
    .collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("更新恢复目录未能打开，请查看日志。".into())
    } else {
        Ok(())
    }

    })();
    diagnostic_log.native_outcome("open_update_recovery", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
fn open_rivalhub_authorization(url: String, log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
    let parsed = tauri::Url::parse(&url).map_err(|error| command_log.preserve_error("open_rivalhub_authorization", native_operation_id.as_deref(), &error, "授权页面地址无效。"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("match.starfie1d.top")
        || parsed.port().is_some()
        || parsed.path() != "/integrations/mizar/connect"
        || parsed
            .query_pairs()
            .find(|(key, _)| key == "pairingId")
            .is_none()
    {
        return Err("授权页面地址无效。".into());
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("浏览器未能打开，请重试。".into())
    } else {
        Ok(())
    }

    })();
    diagnostic_log.native_outcome("open_rivalhub_authorization", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

fn background_powershell() -> Command {
    let mut command = Command::new("powershell.exe");
    // PowerShell 7's inherited module path hides Windows PowerShell's built-in
    // modules (including Get-FileHash). Let the child initialize its own path.
    command
        .env_remove("PSModulePath")
        .stdin(Stdio::null())
        .creation_flags(0x08000000);
    command
}

fn gsi_script(
    name: &str,
    root: Option<&Path>,
    timeout: Duration,
    log: &DesktopLog,
) -> Result<String, String> {
    let bundle = bundle_root()?;
    let mut command = background_powershell();
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(bundle.join("resources/scripts").join(name))
        .current_dir(&bundle);
    if name != "gsi-status.ps1" {
        command.arg("-Product");
    }
    if let Some(path) = root {
        command.arg("-Cs2Root").arg(powershell::provider_path(path));
    }
    let operation = match name {
        "gsi-status.ps1" => "CS2 与 GSI 检测",
        "install-gsi.ps1" => "安装 GSI",
        "restore-gsi.ps1" => "恢复 GSI",
        "select-cs2-installation.ps1" => "保存 CS2 安装位置",
        _ => "CS2 配置",
    };
    powershell::run(command, log, operation, timeout)
}

fn valid_workbench_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() == 5
        && parts[1] == "admin"
        && parts[3] == "matches"
        && [parts[2], parts[4]].iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

#[tauri::command]
fn open_rivalhub_workbench(url: String, log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
    let parsed = tauri::Url::parse(&url).map_err(|error| command_log.preserve_error("open_rivalhub_workbench", native_operation_id.as_deref(), &error, "比赛工作台地址无效。"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("match.starfie1d.top")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !valid_workbench_path(parsed.path())
    {
        return Err("比赛工作台地址无效。".into());
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err("浏览器未能打开，请重试。".into())
    } else {
        Ok(())
    }

    })();
    diagnostic_log.native_outcome("open_rivalhub_workbench", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn gsi_status(log: tauri::State<'_, DesktopLog>) -> Result<serde_json::Value, String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
        let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
        let result = powershell::parse(&log, "GSI 检测", &output)?;
        // Paths are available only in the private desktop UI; exports redact them.
        Ok(cs2_diagnostics::gsi_status(&result))
    })
    .await
    .map_err(|_| "GSI 状态读取失败。".to_string())?
}

#[tauri::command]
async fn save_support_bundle(app: tauri::AppHandle, contents: String) -> Result<bool, String> {
    support_export::validate(&contents)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("保存 Mizar 诊断包")
            .set_file_name(format!(
                "mizar-support-{}.json",
                chrono::Utc::now().format("%Y%m%d-%H%M%S")
            ))
            .add_filter("Mizar 诊断包", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|_| "保存位置无效，请重新选择。")?;
        support_export::save(&path, &contents)?;
        Ok(true)
    })
    .await
    .map_err(|_| "保存窗口未能打开，请重试。".to_string())?
}

#[tauri::command]
async fn select_cs2_installation(app: tauri::AppHandle, executable: bool,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<bool, String> = async move {
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let cs2 = managed.lock().map_err(|error| command_log.preserve_error("select_cs2_installation", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。"))?;
        if cs2.status()?["pending"] == true {
            return Err("请先退出受管理 CS2 并恢复设置，再更改安装位置。".into());
        }
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|error| command_log.preserve_error("select_cs2_installation", native_operation_id.as_deref(), &error, "GSI 操作状态不可用。"))?;
        let dialog = app.dialog().file().set_title("选择 CS2 安装位置");
        let file = if executable {
            dialog.add_filter("CS2 程序", &["exe"]).blocking_pick_file()
        } else {
            dialog.blocking_pick_folder()
        };
        let Some(file) = file else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|error| command_log.preserve_error("select_cs2_installation", native_operation_id.as_deref(), &error, "安装位置无效。"))?;
        gsi_script(
            "select-cs2-installation.ps1",
            Some(&path),
            Duration::from_secs(20),
            &app.state::<DesktopLog>(),
        )?;
        Ok(true)
    } })
    .await
    .map_err(|error| command_log.preserve_error("select_cs2_installation", native_operation_id.as_deref(), &error, "安装位置选择未完成。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("select_cs2_installation", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn open_cs2_config_directory(log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = async move {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|error| command_log.preserve_error("open_cs2_config_directory", native_operation_id.as_deref(), &error, "GSI 操作状态不可用。"))?;
        let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
        let result = powershell::parse(&log, "GSI 检测", &output)?;
        let path = result["cfgPath"]
            .as_str()
            .map(PathBuf::from)
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .filter(|path| path.is_dir())
            .ok_or("尚未找到配置文件夹，请先选择 CS2 安装位置。")?;
        let explorer =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?)
                .join("explorer.exe");
        Command::new(explorer)
            .arg(path)
            .spawn()
            .map_err(|error| command_log.preserve_error("open_cs2_config_directory", native_operation_id.as_deref(), &error, "配置文件夹无法打开。"))?;
        Ok(())
    } })
    .await
    .map_err(|error| command_log.preserve_error("open_cs2_config_directory", native_operation_id.as_deref(), &error, "配置文件夹无法打开。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("open_cs2_config_directory", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn ensure_gsi(log: tauri::State<'_, DesktopLog>, diagnostic_operation_id: Option<String>) -> Result<serde_json::Value, String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<serde_json::Value, String> = async move {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|error| command_log.preserve_error("ensure_gsi", native_operation_id.as_deref(), &error, "GSI 操作状态不可用。"))?;
        gsi_script("ensure-gsi.ps1", None, Duration::from_secs(45), &log)?;
        let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
        let result = powershell::parse(&log, "GSI 检测", &output)?;
        Ok(cs2_diagnostics::gsi_status(&result))
    } })
    .await
    .map_err(|error| command_log.preserve_error("ensure_gsi", native_operation_id.as_deref(), &error, "GSI 自动配置未完成。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("ensure_gsi", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

#[tauri::command]
async fn configure_gsi(app: tauri::AppHandle, restore: bool, choose: bool, diagnostic_operation_id: Option<String>) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = async move {
    tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|error| command_log.preserve_error("configure_gsi", native_operation_id.as_deref(), &error, "GSI 操作状态不可用。"))?;
        let root = if choose {
            let Some(file) = app.dialog().file().blocking_pick_folder() else {
                return Ok(());
            };
            Some(file.into_path().map_err(|error| command_log.preserve_error("configure_gsi", native_operation_id.as_deref(), &error, "安装目录无效。"))?)
        } else {
            None
        };
        gsi_script(
            if restore {
                "restore-gsi.ps1"
            } else {
                "install-gsi.ps1"
            },
            root.as_deref(),
            Duration::from_secs(45),
            &app.state::<DesktopLog>(),
        )?;
        Ok(())
    } })
    .await
    .map_err(|error| command_log.preserve_error("configure_gsi", native_operation_id.as_deref(), &error, "GSI 配置工具未能启动。".to_string()))?

    }.await;
    diagnostic_log.native_outcome("configure_gsi", diagnostic_operation_id.as_deref(), &diagnostic_result);
    diagnostic_result
}

fn run_desktop(
    log: DesktopLog,
    exit_signal: ExitSignal,
    job: Arc<RuntimeJob>,
    update_stage: Arc<Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let exit_request = Arc::new(
        ExitRequest::new(&shutdown_scope(&bundle_root()?)?).map_err(|error| error.to_string())?,
    );
    let activation = windows_startup::ActivationSignal::new()
        .map_err(|_| "无法建立桌面窗口恢复信号。".to_string())?;
    // A retained Companion must revoke the previous Host before any UI can reconnect.
    production_exit::camera_session(&log, "host-start", None, None)?;
    let managed = managed_cs2::ManagedCs2::new(log.clone());
    let mut tracker = GameTracker::default();
    tracker.overlay_enabled = true;
    tracker.preserve_settings = managed.preserve_settings();
    let running = Arc::new(AtomicBool::new(true));
    let worker = Arc::new(Mutex::new(None::<thread::JoinHandle<()>>));
    let setup_worker = worker.clone();
    let console_worker = Arc::new(Mutex::new(None));
    let setup_console_worker = console_worker.clone();
    let dispatch = Arc::new(Mutex::new(()));
    let setup_dispatch = dispatch.clone();
    let state = HostState {
        tracker: Arc::new(Mutex::new(tracker)),
        visible: Arc::new(AtomicBool::new(false)),
        layout_dirty: Arc::new(AtomicBool::new(false)),
        running: running.clone(),
        live_window_lock: Mutex::new(()),
        tray_available: AtomicBool::new(false),
        fullscreen_scope: Mutex::new(workspace_shell::FullscreenScope::default()),
        window_group: Mutex::new(workspace_group::Group::default()),
        entry_focus: Mutex::new(workspace_focus::Entry::default()),
    };
    log.event("tauri_begin", "begin", None);
    let setup_log = log.clone();
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(log.clone())
        .manage(Mutex::new(managed))
        .manage(Mutex::new(demo_test::Selection::default()))
        .manage(cs2_activity::Activity::default())
        .manage(production_exit::ExitGate::default())
        .manage(DemoEntryIntent::default())
        .manage(production_exit::WorkspaceExit::default())
        .manage(production_exit::VerifiedStop::default())
        .manage(updates::PendingUpdate::new(update_stage))
        .invoke_handler(|invoke| {
            let command = invoke.message.command();
            if !["gsi_status", "mulnx_handoff_status", "cs2_host_status", "cs2_config_status", "cs2_console_status", "workspace_exit_status", "read_obs_configuration_context", "save_support_bundle"].contains(&command) {
                let log = invoke.message.webview_ref().state::<DesktopLog>();
                let payload = match invoke.message.payload() {
                    tauri::ipc::InvokeBody::Json(value) => value.clone(),
                    tauri::ipc::InvokeBody::Raw(bytes) => serde_json::json!({"binaryBytes":bytes.len()}),
                };
                log.event("native_command", "begin", Some(&serde_json::json!({"command":command,"window":invoke.message.webview_ref().label(),"parameters":payload}).to_string()));
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            restore_layout,
            restore_cs2_focus,
            set_program_overlay_enabled,
            cs2_host_status,
            select_obs_executable,
            launch_obs,
            begin_obs_configuration,
            finish_obs_configuration,
            read_obs_configuration_context,
            cs2_config_status,
            mulnx_handoff_status,
            launch_mulnx,
            mulnx_control,
            open_mulnx_browser,
            observer_workspace::observer_command,
            start_managed_cs2,
            begin_managed_camera,
            cancel_managed_camera,
            attach_external_cs2,
            finish_managed_cs2,
            finish_workspace,
            workspace_exit_status,
            select_demo_file,
            start_demo_test,
            enter_demo_test,
            resume_demo_test,
            present_demo_test,
            begin_demo_entry,
            cancel_demo_entry,
            finish_demo_test,
            restore_cs2_backup,
            open_cs2_backup,
            manage_cs2_backup,
            set_cs2_preferences,
            cs2_console_status,
            set_cs2_console_capture,
            open_main,
            present_production,
            open_tool,
            close_review,
            open_rivalhub_authorization,
            open_steam_api_key,
            open_issue_report,
            install_update,
            open_update_page,
            open_music_downloads,
            open_update_recovery,
            open_rivalhub_workbench,
            save_support_bundle,
            gsi_status,
            configure_gsi,
            ensure_gsi,
            select_cs2_installation,
            open_cs2_config_directory
        ];
            handler(invoke)
        })
        .setup(move |app| {
            let handle = app.handle();
            let page_log = setup_log.clone();
            setup_log.step("main_window", || {
                WebviewWindowBuilder::new(handle, "main", local_url("/"))
                    .title("Mizar")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(720.0, 560.0)
                    .maximized(true)
                    .visible(true)
                    .on_navigation(trusted_navigation)
                    .on_page_load(move |_window, payload| {
                        if payload.event() == tauri::webview::PageLoadEvent::Started {
                            obs_configuration::document_changed(&page_log);
                        }
                        if payload.event() == tauri::webview::PageLoadEvent::Finished
                            && trusted_navigation(payload.url())
                        {
                            // Navigation finished; this does not assert React or production readiness.
                            page_log.event("main_page_load", "success", None);
                        }
                    })
                    .build()
            })?;
            // Live-only windows are created transactionally by present_production.
            // A tray failure must not discard a successfully created Main window.
            let tray = setup_log.step("tray", || -> tauri::Result<()> {
                let open = MenuItem::with_id(
                    handle,
                    "open_workspace",
                    "打开 / 恢复制播工作区",
                    true,
                    None::<&str>,
                )?;
                let control =
                    MenuItem::with_id(handle, "open_operator", "打开 Mizar", true, None::<&str>)?;
                let exit = MenuItem::with_id(handle, "exit", "退出 Mizar", true, None::<&str>)?;
                let hide = MenuItem::with_id(
                    handle,
                    "hide_workspace",
                    "隐藏制播工作区",
                    true,
                    None::<&str>,
                )?;
                let menu = Menu::with_items(handle, &[&control, &open, &hide, &exit])?;
                TrayIconBuilder::new()
                    .icon(tauri::include_image!("./icons/tray-icon.png"))
                    .menu(&menu)
                    .on_menu_event(move |app, event| match event.id().as_ref() {
                        "open_workspace" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window_presentation::set_visible(&window, true);
                                let _ =
                                    window.eval("window.dispatchEvent(new Event('mizar-enter'))");
                            }
                        }
                        "hide_workspace" => {
                            let _ = hide_workspace(app);
                            if let Some(window) = app.get_webview_window("workspace-dock") {
                                let _ =
                                    window.eval("window.dispatchEvent(new Event('mizar-hide'))");
                            }
                        }
                        "open_operator" => {
                            let _ = open_main(app.clone(), None, None);
                        }
                        "exit" => {
                            // ExitRequested can reject cleanup. Keep tracking until RunEvent::Exit.
                            app.exit(0);
                        }
                        _ => (),
                    })
                    .build(handle)?;
                Ok(())
            });
            handle
                .state::<HostState>()
                .tray_available
                .store(tray.is_ok(), Ordering::Relaxed);
            if tray.is_err() {
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.set_title("Mizar · 托盘不可用，关闭主窗口将退出");
                }
            }
            setup_log.event("setup_complete", "success", None);
            updates::check_on_startup(setup_log.clone());
            let host = handle.clone();

            let worker_running = host.state::<HostState>().running.clone();
            let console_running = worker_running.clone();
            let console_log = setup_log.clone();
            let console_host = host.clone();
            let console_thread = thread::spawn(move || cs2_console::run_worker(console_log, console_running, console_host));
            *setup_console_worker.lock().map_err(|_| "技术日志线程状态不可用。")? = Some(console_thread);
            let worker_tracker = host.state::<HostState>().tracker.clone();
            let worker_visible = host.state::<HostState>().visible.clone();
            let worker_layout_dirty = host.state::<HostState>().layout_dirty.clone();
            let pending = Arc::new(AtomicBool::new(false));
            let worker = thread::spawn(move || {
                let mut cs2_check = Instant::now() - Duration::from_secs(2);
                while worker_running.load(Ordering::Relaxed) {
                    if cs2_check.elapsed() >= Duration::from_secs(2) {
                        if let Ok(mut cs2) =
                            host.state::<Mutex<managed_cs2::ManagedCs2>>().try_lock()
                        {
                            cs2.poll();
                            observer_workspace::pulse(&host, &cs2);
                            if let Some((lease, invalid)) = cs2.managed_camera_lease() {
                                let log = host.state::<DesktopLog>();
                                let action = if invalid { "invalidate" } else { "pulse" };
                                match production_exit::camera_session(&log, action, Some(&lease), None) {
                                    Ok(_) if invalid => cs2.clear_managed_camera(),
                                    Ok(_) => (),
                                    Err(error) => {
                                        cs2.invalidate_managed_camera();
                                        log.event("managed_camera_isolation", "failure", Some(&error));
                                    }
                                }
                            }
                            if let Some(lease) = cs2.external_camera_lease().map(str::to_owned) {
                                let log = host.state::<DesktopLog>();
                                let invalid = cs2.external_isolation_pending();
                                let action = if invalid { "invalidate" } else { "pulse" };
                                match production_exit::camera_session(&log, action, Some(&lease), None) {
                                    Ok(_) if invalid => cs2.external_isolated(),
                                    Ok(_) => (),
                                    Err(error) => {
                                        cs2.invalidate_external();
                                        log.event("external_game_isolation", "failure", Some(&error));
                                    },
                                }
                            }
                            refresh_finished_window_feedback(&host, &cs2);
                            if let Ok(mut tracker) = worker_tracker.lock() {
                                tracker.preserve_settings = cs2.preserve_settings();
                            }
                        }
                        cs2_check = Instant::now();
                    }
                    // Window linkage owns no lifecycle or geometry. A verified
                    // process handle is held through this bounded operation;
                    // lock contention, hide and exit all fail closed.
                    let allowed = || {
                        worker_running.load(Ordering::Acquire)
                            && worker_visible.load(Ordering::Acquire)
                            && !exit_signal.requested()
                            && host.state::<production_exit::ExitGate>().check().is_ok()
                            && host.state::<cs2_activity::Activity>().phase() == "idle"
                    };
                    let process = if allowed() {
                        host.state::<Mutex<managed_cs2::ManagedCs2>>()
                            .try_lock()
                            .ok()
                            .and_then(|cs2| cs2.workspace_process().ok().flatten())
                    } else {
                        None
                    };
                    let panels = host
                        .get_webview_window("workspace-left")
                        .zip(host.get_webview_window("workspace-dock"))
                        .and_then(|(left, dock)| left.hwnd().ok().zip(dock.hwnd().ok()))
                        .map(|(left, dock)| [left.0 as isize, dock.0 as isize]);
                    let mut group_outcome = None;
                    if let Ok(mut group) = host.state::<HostState>().window_group.lock() {
                        let failure = workspace_group::synchronize(
                            &mut group, process.as_ref().filter(|process| process.owned), panels, &allowed,
                        );
                        group_outcome = Some((group.restored, failure));
                        if let Some(failure) = failure {
                            if let Some(process) = &process {
                                let mut detail = failure.diagnostic();
                                detail["gamePid"] = serde_json::json!(process.pid);
                                detail["created"] = serde_json::json!(process.created);
                                host.state::<DesktopLog>().event("workspace_group_restore", "failure", Some(&detail.to_string()));
                            }
                        }
                    }

                    // Cross-process CS2 calls stay off the Tauri main loop.
                    let (layout, rect) = if !pending.load(Ordering::Relaxed)
                        && worker_visible.load(Ordering::Relaxed)
                        && !exit_signal.requested()
                    {
                        let workspace_windows = overlay_workspace_windows(&host);
                        worker_tracker
                            .lock()
                            .ok()
                            .map(|mut tracker| {
                                // A DPI change can resize a WebView without changing CS2's
                                // physical client or DPI. Reapply the shared physical layout
                                // after the native suggested-size handler has completed.
                                let layout = if worker_layout_dirty.swap(false, Ordering::AcqRel) {
                                    tracker.restore_layout()
                                } else {
                                    tracker.tick()
                                };
                                if let Some(failure) = tracker.alignment_event() {
                                    host.state::<DesktopLog>().event("cs2_window_alignment", "failure", Some(&failure.diagnostic().to_string()));
                                }
                                (layout, tracker.overlay_rect(&workspace_windows))
                            })
                            .unwrap_or((None, None))
                    } else {
                        (None, None)
                    };
                    // Apply the outcome after discovery; discovering this same new game
                    // must not erase a group failure observed earlier in this tick.
                    if let Some((restored, failure)) = group_outcome {
                        if let Ok(mut tracker) = worker_tracker.lock() {
                            if restored { tracker.group_failure = None; }
                            if let Some(failure) = failure { tracker.group_failure = Some(failure); }
                        }
                    }
                    let Ok(_dispatch) = setup_dispatch.lock() else {
                        break;
                    };
                    if !worker_running.load(Ordering::Relaxed) {
                        break;
                    }
                    if !pending.swap(true, Ordering::Relaxed) {
                        let activate = activation.requested();
                        let request_exit = exit_request.requested();
                        let tick_host = host.clone();
                        let tick_running = worker_running.clone();
                        let tick_pending = pending.clone();
                        let tick_signal = exit_signal.clone();
                        if host
                            .run_on_main_thread(move || {
                                if tick_running.load(Ordering::Relaxed) {
                                    if request_exit {
                                        tick_host.exit(0);
                                    } else if tick_signal.requested() {
                                        // A failed game restoration stays open for manual retry.
                                        // Consume the verified signal once; do not reopen a dialog each tick.
                                        if !tick_host
                                            .state::<production_exit::VerifiedStop>()
                                            .complete()
                                        {
                                            tick_host.state::<DesktopLog>().event(
                                                "runtime_stopped",
                                                "success",
                                                Some("Explicit verified stop completed."),
                                            );
                                            tick_host
                                                .state::<production_exit::VerifiedStop>()
                                                .mark();
                                            tick_host.exit(0);
                                        }
                                    } else {
                                        if activate {
                                            let _ = open_main(tick_host.clone(), None, None);
                                        }
                                        if tick_host
                                            .state::<HostState>()
                                            .visible
                                            .load(Ordering::Relaxed)
                                        {
                                            sync_workspace_shell(&tick_host);
                                            if let Some(layout) = layout {
                                                apply_layout(&tick_host, layout);
                                            }
                                            present_overlay(&tick_host, rect);
                                        } else {
                                            present_overlay(&tick_host, None);
                                        }
                                        window_presentation::sync_all(&tick_host);
                                    }
                                }
                                tick_pending.store(false, Ordering::Relaxed);
                            })
                            .is_err()
                        {
                            worker_running.store(false, Ordering::Relaxed);
                        }
                    }
                    drop(_dispatch);
                    thread::sleep(Duration::from_millis(250));
                }
            });
            *setup_worker
                .lock()
                .map_err(|_| "桌面调度线程状态不可用。")? = Some(worker);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                obs_configuration::document_changed(window.state::<DesktopLog>().inner());
            }
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    let _ = window_presentation::sync_visibility(&webview);
                }
            }
            if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. })
                && matches!(
                    window.label(),
                    "workspace-left" | "workspace-dock" | "program-overlay"
                )
            {
                // Coalesce all native-window notifications on the existing worker.
                // Hidden workspaces keep this invalidation until they are shown.
                window
                    .state::<HostState>()
                    .layout_dirty
                    .store(true, Ordering::Release);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    window.state::<DemoEntryIntent>().cancel_all();
                }
                match window.label() {
                    "tool-review" => { let _ = window.destroy(); }
                    "workspace-left" | "workspace-dock" => {
                        let _ = hide_workspace(window.app_handle());
                        if let Some(dock) = window.app_handle().get_webview_window("workspace-dock")
                        {
                            let _ = dock.eval("window.dispatchEvent(new Event('mizar-hide'))");
                        }
                        if !window
                            .state::<HostState>()
                            .tray_available
                            .load(Ordering::Relaxed)
                        {
                            let _ = open_main(window.app_handle().clone(), None, None);
                        }
                    }
                    "main"
                        if !window
                            .state::<HostState>()
                            .tray_available
                            .load(Ordering::Relaxed) =>
                    {
                        window.app_handle().exit(0)
                    }
                    _ => {
                        let _ = window.hide();
                        if let Some(webview) =
                            window.app_handle().get_webview_window(window.label())
                        {
                            let _ = window_presentation::sync_visibility(&webview);
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .map_err(|error| {
            let message = format!("{error}\n{error:?}");
            log.event("run_error", "failure", Some(&message));
            message
        })?;
    // run() terminates the process. run_return() lets the outer owner stop the
    // Companion and persist cleanup diagnostics before leaving the process.
    let console_guard = DesktopWorker {
        running: running.clone(), dispatch: Arc::new(Mutex::new(())), handle: console_worker,
    };
    let worker_guard = DesktopWorker {
        running: running.clone(),
        dispatch: dispatch.clone(),
        handle: worker.clone(),
    };
    let ready_error = Arc::new(Mutex::new(None));
    let callback_error = ready_error.clone();
    let exit_cleanup_done = Arc::new(AtomicBool::new(false));
    let exit_code = application.run_return(move |app, event| match event {
        tauri::RunEvent::Ready => {
            match log.step("runtime_startup_committed", || job.kill_on_close(false)) {
                Ok(()) => log.event("host_loop_ready", "success", None),
                Err(error) => {
                    if let Ok(mut failure) = callback_error.lock() {
                        *failure = Some(error);
                    }
                    app.exit(1);
                }
            }
        }
        tauri::RunEvent::ExitRequested { api, code, .. }
            if code.unwrap_or(0) == 0 && !exit_cleanup_done.load(Ordering::Acquire) =>
        {
            api.prevent_exit();
            if !app.state::<production_exit::ExitGate>().begin() {
                return;
            }
            let done = exit_cleanup_done.clone();
            let host = app.clone();
            // Serialize with an in-flight launch; keep the UI loop responsive.
            tauri::async_runtime::spawn(async move {
                let cleanup_host = host.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    // The gate is already closed; wait for an accepted launch,
                    // then keep its lock through safe production and game cleanup.
                    let state = cleanup_host.state::<Mutex<managed_cs2::ManagedCs2>>();
                    let mut cs2 = state.lock().map_err(|_| "CS2 配置状态不可用。")?;
                    let activity = cleanup_host.state::<cs2_activity::Activity>();
                    let _activity = activity.begin(if cs2.has_external() { 3 } else { 2 });
                    production_exit::finish_then_restore(
                        || {
                            // --stop already completed the same safe transaction before
                            // stopping the verified service; no HTTP request can follow it.
                            if cleanup_host
                                .state::<production_exit::VerifiedStop>()
                                .complete()
                            {
                                Ok(())
                            } else {
                                production_exit::finish_companion(
                                    &cleanup_host.state::<DesktopLog>(),
                                )
                            }
                        },
                        || {
                            production_exit::restore_then_cleanup(
                                || if cleanup_host.state::<production_exit::VerifiedStop>().complete() {
                                    observer_hud::restore(&cleanup_host.state::<DesktopLog>())
                                } else { observer_workspace::finish(&cleanup_host.state::<DesktopLog>()) },
                                || cs2.finish_with_service_stopped(cleanup_host.state::<production_exit::VerifiedStop>().complete()),
                            )
                        },
                    )
                })
                .await
                .unwrap_or_else(|_| Err("退出收尾未完成，请重试。".into()));
                if let Err(error) = result {
                    updates::cancel(&host);
                    host.state::<DesktopLog>()
                        .event("cs2_exit_recovery", "failure", Some(&error));
                    host.state::<production_exit::ExitGate>().cancel();
                    let _ = hide_workspace(&host);
                    if host.state::<production_exit::VerifiedStop>().complete() {
                        // Direct service-stop callers may already have removed HTTP.
                        // Native recovery remains available through the tray, never a refused WebView.
                        for window in host.webview_windows().values() {
                            let _ = window.destroy();
                        }
                    } else {
                        let _ = open_main(host.clone(), Some("/".into()), None);
                    }
                    host.dialog()
                        .message(format!(
                            "退出 Mizar 未完成，待恢复记录仍保留。\n{error}\n请修复后重试退出。"
                        ))
                        .title("Mizar 退出未完成")
                        .show(|_| {});
                    return;
                }
                done.store(true, Ordering::Release);
                host.exit(code.unwrap_or(0));
            });
        }
        tauri::RunEvent::Exit => {
            DesktopWorker {
                running: running.clone(),
                dispatch: dispatch.clone(),
                handle: worker.clone(),
            }
            .stop();
        }
        _ => (),
    });
    worker_guard.stop();
    console_guard.stop();
    // Tauri APIs must not be used after run_return has cleaned up the application.
    let ready_error = ready_error.lock().ok().and_then(|error| error.clone());
    if let Some(error) = ready_error {
        Err(error)
    } else if exit_code == 0 {
        Ok(())
    } else {
        Err(format!("桌面界面异常退出（{exit_code}）；请查看运行日志。"))
    }
}

fn start_gui(root: &Path, log: &DesktopLog) -> Result<(), String> {
    let update_stage = Arc::new(Mutex::new(None));
    let scope = log.step("shutdown_scope", || shutdown_scope(root))?;
    let exit_signal = log.step("shutdown_signal", || ExitSignal::new(&scope))?;
    let _observer_job = log.step("observer_job", || observer_job::create(&log.session_id))?;
    let job = Arc::new(log.step("runtime_job", RuntimeJob::new)?);
    let mut child = log.step("runtime_spawn", || {
        supervisor(root, "--no-browser", Some(log))
    })?;
    let outcome = (|| {
        log.step("runtime_job_assignment", || job.assign(&child))?;
        log.step("runtime_release", || {
            child
                .stdin
                .take()
                .ok_or_else(|| std::io::Error::other("supervisor startup pipe unavailable"))?
                .write_all(b"MIZAR_DESKTOP_START\n")
        })?;
        log.step("runtime_ready", || {
            wait_for_runtime(root, &mut child, Some(log))
        })?;
        if let Err(error) = observer_hud::restore(log) { log.event("observer_hud_recovery", "failure", Some(&error)); }
        let version = log.step("webview2_preflight", webview_preflight)?;
        log.event("webview2_version", "success", Some(&version));
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_desktop(log.clone(), exit_signal, job.clone(), update_stage.clone())
        })) {
            Ok(result) => result,
            Err(_) => Err("桌面界面启动或运行时发生异常；原始 panic 信息已记录。".into()),
        }
    })();
    let cleanup_stage = if outcome.is_err() {
        "startup_rollback"
    } else {
        "shutdown"
    };
    log.event(cleanup_stage, "begin", None);
    // Failure cannot stop a same-artifact runtime borrowed from another session.
    // A successful desktop session's explicit exit may stop its verified local runtime.
    if runtime_owned(log, child.id()) || (outcome.is_ok() && health_matches(root)) {
        let stopped = log.step("runtime_stop", || stop_runtime(root, Some(log)));
        if stopped.is_err() {
            if let Ok(mut pending) = update_stage.lock() {
                if let Some(stage) = pending.take() {
                    let _ = fs::remove_dir_all(stage);
                }
            }
        }
    } else {
        log.event(
            "runtime_stop",
            "skipped",
            Some("No runtime owned by this startup session."),
        );
    }
    // Only our wrapper and descendants belong to this job. After Ready, handle
    // closure alone preserves Companion on an unexpected Host process exit.
    let job_cleanup = log.step("runtime_job_cleanup", || job.terminate());
    drop(job);
    if wait_child(&mut child, Duration::from_secs(5)).is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Err(error) = job_cleanup {
        log.event(cleanup_stage, "failure", Some(&error));
        return Err(format!(
            "startup_rollback_failed: {error}\nOriginal startup outcome: {outcome:?}"
        ));
    }
    log.event(cleanup_stage, "success", None);
    if outcome.is_ok() {
        if let Some(stage) = update_stage
            .lock()
            .map_err(|_| "更新安装状态不可用。")?
            .take()
        {
            updates::launch(&stage, log)?;
        }
    }
    outcome
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--observer-process") {
        std::process::exit(observer_job::run(&args[1..]).unwrap_or_else(|error| {
            eprintln!("observer_owner: {error}"); 1
        }));
    }
    if args == ["--app-version"] {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let headless = args.iter().any(|arg| arg == "--no-browser");
    if args
        .iter()
        .any(|arg| arg != "--stop" && arg != "--no-browser")
    {
        if !headless {
            failure_dialog("启动参数无法识别。", None);
        }
        eprintln!("启动参数无法识别。");
        std::process::exit(1);
    }
    let root = match bundle_root() {
        Ok(root) => root,
        Err(message) => {
            if !headless {
                failure_dialog(&message, None);
            }
            eprintln!("{message}");
            std::process::exit(1);
        }
    };
    if args.iter().any(|arg| arg == "--stop") {
        let host_stop = (|| -> Result<bool, String> {
            let scope = shutdown_scope(&root)?;
            if !ExitRequest::exists(&scope).map_err(|error| error.to_string())? {
                return Ok(false);
            }
            // Never stop the child before the Host has restored the managed game.
            if !health_matches(&root) {
                return Err("无法核对此目录的制播服务，未提交退出请求。".into());
            }
            if !ExitRequest::notify(&scope).map_err(|error| error.to_string())? {
                return Ok(false);
            }
            let deadline = Instant::now() + Duration::from_secs(40);
            while Instant::now() < deadline {
                if !ExitRequest::exists(&scope).map_err(|error| error.to_string())?
                    && !health_matches(&root)
                {
                    return Ok(true);
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err("桌面退出尚未完成，请查看恢复提示并重试；制播服务仍保留。".into())
        })();
        match host_stop {
            Ok(true) => return,
            Ok(false) => (),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        if let Err(error) = stop_runtime(&root, None) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    // Rejection exits this image promptly; feedback belongs to the update tool.
    match windows_startup::reject_update_start(headless) {
        Ok(false) => (),
        Ok(true) => std::process::exit(1),
        Err(error) => {
            eprintln!("无法核对更新状态，暂未启动 Mizar：{error}");
            std::process::exit(1);
        }
    }
    // Automation does not initialize Tauri, acquire the GUI mutex or rotate desktop logs.
    if headless {
        let outcome = supervisor(&root, "--no-browser", None).and_then(|mut child| {
            wait_for_runtime(&root, &mut child, None)?;
            child
                .wait()
                .map_err(|error| format!("制播服务进程异常：{error:?}"))
                .and_then(|status| {
                    if status.success() {
                        Ok(())
                    } else {
                        Err(format!("制播服务异常退出：{status}"))
                    }
                })
        });
        if let Err(error) = outcome {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let _mutex = match DesktopMutex::acquire() {
        Ok(Some(mutex)) => mutex,
        Ok(None) => {
            if !matches!(windows_startup::reject_update_start(false), Ok(true)) {
                windows_startup::ActivationSignal::notify();
            }
            return;
        }
        Err(error) => {
            failure_dialog(&format!("桌面工作区锁不可用：{error}"), None);
            std::process::exit(1);
        }
    };
    let log = match DesktopLog::new(
        &root,
        std::env::var_os("MIZAR_STATE_ROOT").map(PathBuf::from),
    ) {
        Ok(log) => log,
        Err(error) => {
            failure_dialog(&format!("无法创建启动日志：{error}"), None);
            std::process::exit(1);
        }
    };
    log.install_panic_hook();
    log.event("bundle_root_resolved", "success", None);
    log.event("mutex_acquired", "success", None);
    log.event(
        "windows_version",
        "success",
        Some(&windows_startup::windows_version()),
    );
    while let Err(error) = start_gui(&root, &log) {
        log.event("startup_failed", "failure", Some(&error));
        if error.starts_with("webview2_preflight:") {
            if windows_startup::recover_webview(&log, webview_preflight) {
                continue;
            }
        } else {
            if startup_recovery::show(&log, &error) {
                continue;
            }
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn demo_entry_cancellation_and_page_change_block_publication() {
        let intent = DemoEntryIntent::default();
        let shown = std::cell::Cell::new(false);
        intent.begin("first".into()).unwrap();
        intent.cancel("first").unwrap();
        assert!(!intent.publish("first", || true, || shown.set(true)));
        intent.begin("second".into()).unwrap();
        assert!(!intent.publish("second", || false, || shown.set(true)));
        intent.begin("third".into()).unwrap();
        intent.cancel("second").unwrap();
        assert!(intent.publish("third", || true, || shown.set(true)));
        assert!(shown.get());
        assert!(!intent.publish("third", || true, || panic!("entry is one-shot")));
        intent.begin("closing".into()).unwrap();
        intent.cancel_all();
        assert!(!intent.publish("closing", || true, || panic!("closed window must stay closed")));
        intent.begin("reopened".into()).unwrap();
        assert!(intent.publish("reopened", || true, || {}));
    }

    #[test]
    fn review_capability_matches_the_windows_ipc_origin() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/review.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["tool-review"]));
        assert_eq!(capability["permissions"], serde_json::json!(["allow-close-review"]));
        let pattern: tauri_utils::acl::RemoteUrlPattern = capability["remote"]["urls"][0].as_str().unwrap().parse().unwrap();
        // Windows IPC authorizes the Origin header, which has no document path.
        assert!(pattern.test(&"http://127.0.0.1:3000/".parse().unwrap()));
        assert!(!pattern.test(&"http://127.0.0.1:3001/".parse().unwrap()));
        assert!(!pattern.test(&"http://example.com:3000/".parse().unwrap()));
    }

    #[test]
    fn preparation_routes_are_exact_and_include_workspace_settings_links() {
        for path in ["/", "/matches", "/settings?tab=gsi", "/settings?tab=obs",
            "/settings?tab=rivalhub", "/settings?tab=music", "/settings?tab=camera", "/settings?tab=music&section=camera"] {
            assert!(main_path_allowed(path), "{path}");
        }
        for path in ["https://example.com/", "//example.com", "/workspace", "/settings?tab=music&other=1",
            "/settings?tab=music&section=other", "/settings/../workspace", "/settings?tab=unknown"] {
            assert!(!main_path_allowed(path), "{path}");
        }
    }

    #[test]
    fn rollback_ownership_requires_this_session_and_supervisor() {
        let root = std::env::temp_dir().join(format!(
            "mizar-ownership-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = DesktopLog::new(&root, None).unwrap();
        fs::create_dir_all(log.state_root.join("data")).unwrap();
        let path = log.state_root.join("data/runtime.json");
        assert!(!runtime_owned(&log, 42));
        for (session, pid, expected) in [
            (log.session_id.as_str(), 42, true),
            (log.session_id.as_str(), 43, false),
            ("earlier-session", 42, false),
        ] {
            fs::write(
                &path,
                serde_json::json!({"startupSessionId": session, "supervisorPid": pid}).to_string(),
            )
            .unwrap();
            assert_eq!(runtime_owned(&log, 42), expected);
        }
        fs::write(&path, "malformed").unwrap();
        assert!(!runtime_owned(&log, 42));
        fs::remove_dir_all(root).unwrap();
    }
}
