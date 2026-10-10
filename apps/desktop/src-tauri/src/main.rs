#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cs2_activity;
mod cs2_diagnostics;
mod cs2_frame_rate;
mod cs2_preferences;
mod cs2_session;
mod cs2_spectator;
mod cs2_video;
mod desktop_worker;
mod geometry;
mod managed_cs2;
mod powershell;
mod production_exit;
mod startup_log;
mod startup_wait;
mod support_export;
mod updates;
mod window_frame;
mod window_presentation;
mod windows_host;
mod windows_startup;
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
static OBS_LAUNCH_LOCK: Mutex<()> = Mutex::new(());

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
            .env("MIZAR_DESKTOP_SUPERVISED", "1");
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

fn update_overlay(app: &tauri::AppHandle, state: &HostState) {
    let rect = if state.visible.load(Ordering::Relaxed) {
        state
            .tracker
            .lock()
            .ok()
            .and_then(|tracker| tracker.overlay_rect())
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
        let _ = window_presentation::set_visible(&overlay, true);
    } else {
        let _ = window_presentation::set_visible(&overlay, false);
    }
}

#[tauri::command]
fn restore_layout(app: tauri::AppHandle, state: tauri::State<'_, HostState>) -> Result<(), String> {
    let layout = state
        .tracker
        .lock()
        .map_err(|_| "桌面窗口状态不可用。")?
        .restore_layout()
        .ok_or_else(|| "无法读取显示器工作区。".to_string())?;
    apply_layout(&app, layout);
    update_overlay(&app, &state);
    let tracker = state.tracker.lock().map_err(|_| "桌面窗口状态不可用。")?;
    if tracker.window.is_none() {
        return Err("工作区已恢复，尚未找到 CS2。打开游戏后再恢复布局。".into());
    }
    if !tracker.managed {
        return Err("工作区已恢复，但 CS2 仍使用原来的游戏分辨率。请退出工作台后重新进入，让游戏按当前屏幕尺寸启动。".into());
    }
    Ok(())
}

#[tauri::command]
fn restore_cs2_focus(app: tauri::AppHandle, state: tauri::State<'_, HostState>) -> bool {
    if !state.visible.load(Ordering::Acquire)
        || app.state::<production_exit::ExitGate>().check().is_err()
        || app.state::<cs2_activity::Activity>().phase() != "idle"
    {
        return false;
    }
    let cs2_state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
    let Ok(cs2) = cs2_state.try_lock() else {
        return false;
    };
    let Ok(Some(process)) = cs2.workspace_process() else {
        return false;
    };
    state
        .tracker
        .lock()
        .is_ok_and(|tracker| {
            process.is_running()
                && tracker.window.is_some_and(|window| window.pid == process.pid)
                && tracker.restore_focus()
        })
}

#[tauri::command]
fn set_program_overlay_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .tracker
        .lock()
        .map_err(|_| "桌面窗口状态不可用。")?
        .overlay_enabled = enabled;
    update_overlay(&app, &state);
    Ok(())
}

#[tauri::command]
fn cs2_host_status(state: tauri::State<'_, HostState>) -> serde_json::Value {
    match state.tracker.lock() {
        Ok(tracker) => {
            serde_json::json!({ "found": tracker.window.is_some(), "managed": tracker.managed, "generation": tracker.generation, "geometry": tracker.geometry_diagnostics() })
        }
        Err(_) => serde_json::json!({ "found": false, "managed": false, "generation": 0 }),
    }
}

#[tauri::command]
async fn select_obs_executable(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("OBS Studio", &["exe"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "文件选择器未能打开。".to_string())?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "无法读取所选文件路径。".to_string())?;
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| !name.eq_ignore_ascii_case("obs64.exe"))
        || !path.is_file()
    {
        return Err("请选择 OBS Studio 的 obs64.exe。".into());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
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
) -> Result<bool, String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OBS_LAUNCH_LOCK.lock().map_err(|_| "OBS 启动状态不可用。")?;
        let path = Path::new(&executable_path);
        if !obs_executable_allowed(path) || !path.is_file() {
            return Err("未找到 OBS，请在设置中选择 obs64.exe。".into());
        }
        // Query all processes, including minimized/tray OBS; never start a second instance.
        let mut probe = background_powershell();
        probe.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-Process -Name obs64 -ErrorAction SilentlyContinue).Count",
        ]);
        let output = powershell::run(probe, &log, "OBS 进程检测", Duration::from_secs(10))?;
        let count = output
            .trim()
            .parse::<u32>()
            .map_err(|_| "无法检查 OBS 进程。".to_string())?;
        if count > 0 {
            return Ok(true);
        }
        // Host is outside the runtime Job. Independent OBS must not inherit
        // Companion's rollback/shutdown ownership.
        Command::new(path)
            .current_dir(path.parent().ok_or("OBS 程序未能打开。")?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "OBS 程序未能打开。".to_string())?;
        Ok(false)
    })
    .await
    .map_err(|_| "OBS 程序未能打开。".to_string())?
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
        result
    })
    .await
    .map_err(|_| "CS2 配置状态不可用。".to_string())?
}

#[tauri::command]
async fn start_managed_cs2(
    app: tauri::AppHandle,
    preserve_settings: Option<bool>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 配置状态不可用。")?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(1);
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
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
    .await
    .map_err(|_| "CS2 启动未完成。".to_string())?
}

#[tauri::command]
async fn finish_managed_cs2(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 配置状态不可用。")?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(2);
        cs2.finish()
    })
    .await
    .map_err(|_| "CS2 原配置恢复未完成。".to_string())?
}

#[tauri::command]
async fn set_cs2_preferences(
    app: tauri::AppHandle,
    quality_preset: String,
    frame_rate_limit: u16,
) -> Result<(), String> {
    let preferences = cs2_preferences::Preferences::new(&quality_preset, frame_rate_limit)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 配置状态不可用。")?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(3);
        cs2.preferences(preferences)
    })
    .await
    .map_err(|_| "CS2 启动设置未保存。".to_string())?
}

#[tauri::command]
async fn restore_cs2_backup(
    app: tauri::AppHandle,
    confirm_steam_cancelled: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 配置状态不可用。")?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(2);
        cs2.restore_backup(confirm_steam_cancelled)
    })
    .await
    .map_err(|_| "CS2 原配置恢复未完成。".to_string())?
}

#[tauri::command]
async fn open_cs2_backup(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .state::<Mutex<managed_cs2::ManagedCs2>>()
            .lock()
            .map_err(|_| "CS2 配置状态不可用。")?
            .backup_directory();
        fs::create_dir_all(&path).map_err(|_| "备份目录无法打开。")?;
        let executable =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?)
                .join("explorer.exe");
        Command::new(executable)
            .arg(path)
            .spawn()
            .map_err(|_| "备份目录无法打开。")?;
        Ok(())
    })
    .await
    .map_err(|_| "备份目录无法打开。".to_string())?
}

fn trusted_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(3000)
}

fn show_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.visible.store(true, Ordering::Relaxed);
    sync_workspace_shell(app);
    if let Ok(mut tracker) = state.tracker.lock() {
        if let Some(layout) = tracker.restore_layout() {
            apply_layout(app, layout);
        }
    }
    for label in ["workspace-left", "workspace-dock"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.unminimize();
            let _ = window_presentation::set_visible(&window, true);
        }
    }
    // Select one input target. The group restores its peers without activating
    // them when the existing worker observes this explicit activation.
    if let Some(dock) = app.get_webview_window("workspace-dock") {
        let _ = dock.set_focus();
    }
    update_overlay(app, &state);
}

fn hide_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.visible.store(false, Ordering::Relaxed);
    if let Ok(mut group) = state.window_group.lock() {
        *group = workspace_group::Group::default();
    }
    sync_workspace_shell(app);
    for label in ["workspace-left", "workspace-dock", "program-overlay"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window_presentation::set_visible(&window, false);
        }
    }
}

fn main_path_allowed(path: &str) -> bool {
    [
        "/",
        "/matches",
        "/matches?tab=roster",
        "/picture",
        "/picture?tab=overlay",
        "/settings",
        "/settings?tab=gsi",
        "/settings?tab=obs",
    ]
    .contains(&path)
}

#[tauri::command]
fn open_main(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let path = path.unwrap_or_else(|| "/".into());
    if !main_path_allowed(&path) {
        return Err("页面无法识别。".into());
    }
    if let Some(window) = app.get_webview_window("main") {
        window
            .navigate(
                format!("{BASE}{path}")
                    .parse()
                    .map_err(|_| "页面无法识别。")?,
            )
            .map_err(|_| "无法打开 Mizar。")?;
        let _ = window.unminimize();
        let _ = window_presentation::set_visible(&window, true);
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn present_production(app: tauri::AppHandle, live: bool) -> Result<(), String> {
    if live {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        ensure_live_windows(&app).map_err(|error| {
            format!("现场窗口未能打开，准备中心仍可使用。请打开运行日志后重试。\n{error}")
        })?;
        let state = app.state::<HostState>();
        let layout = state
            .tracker
            .lock()
            .ok()
            .and_then(|mut tracker| tracker.restore_layout());
        if let Some(layout) = layout {
            apply_layout(&app, layout);
        }
        show_workspace(&app);
        if let Some(main) = app.get_webview_window("main") {
            let _ = window_presentation::set_visible(&main, false);
        }
    } else {
        open_main(app.clone(), None)?;
        hide_workspace(&app);
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
                .visible(true)
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
                .visible(true)
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

#[tauri::command]
async fn open_tool(app: tauri::AppHandle, tool: String) -> Result<(), String> {
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    let (label, title, path) = match tool.as_str() {
        "hud" => ("tool-hud", "HUD 工作台", "/operator/hud"),
        "bp" => ("tool-preview", "节目预览", "/preview?scene=bp"),
        "diagnostics" => ("tool-diagnostics", "运行诊断", "/debug"),
        "preview" => ("tool-preview", "节目预览", "/preview"),
        _ => return Err("工具无法识别。".into()),
    };
    if let Some(window) = app.get_webview_window(label) {
        window
            .navigate(
                format!("{BASE}{path}")
                    .parse()
                    .map_err(|_| "工具地址无法识别。")?,
            )
            .map_err(|_| "工具窗口未能恢复。")?;
        let _ = window.unminimize();
        let _ = window_presentation::set_visible(&window, true);
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, label, local_url(path))
        .title(format!("Mizar · {title}"))
        .inner_size(1280.0, 800.0)
        .on_navigation(trusted_navigation)
        .build()
        .map_err(|_| "工具窗口未能打开。")?;
    Ok(())
}

#[tauri::command]
fn open_steam_api_key() -> Result<(), String> {
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
}

#[tauri::command]
fn open_issue_report() -> Result<(), String> {
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
}

#[tauri::command]
async fn install_update(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在制作中心的高级设置中确认升级。".into());
    }
    updates::prepare(app).await
}

#[tauri::command]
fn open_update_page(source: String, version: Option<String>) -> Result<(), String> {
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
}

#[tauri::command]
fn open_update_recovery(app: tauri::AppHandle) -> Result<(), String> {
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
}

#[tauri::command]
fn open_rivalhub_authorization(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "授权页面地址无效。")?;
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
fn open_rivalhub_workbench(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "比赛工作台地址无效。")?;
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
async fn select_cs2_installation(app: tauri::AppHandle, executable: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let cs2 = managed.lock().map_err(|_| "CS2 配置状态不可用。")?;
        if cs2.status()?["pending"] == true {
            return Err("请先退出受管理 CS2 并恢复设置，再更改安装位置。".into());
        }
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
        let dialog = app.dialog().file().set_title("选择 CS2 安装位置");
        let file = if executable {
            dialog.add_filter("CS2 程序", &["exe"]).blocking_pick_file()
        } else {
            dialog.blocking_pick_folder()
        };
        let Some(file) = file else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|_| "安装位置无效。")?;
        gsi_script(
            "select-cs2-installation.ps1",
            Some(&path),
            Duration::from_secs(20),
            &app.state::<DesktopLog>(),
        )?;
        Ok(true)
    })
    .await
    .map_err(|_| "安装位置选择未完成。".to_string())?
}

#[tauri::command]
async fn open_cs2_config_directory(log: tauri::State<'_, DesktopLog>) -> Result<(), String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
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
            .map_err(|_| "配置文件夹无法打开。")?;
        Ok(())
    })
    .await
    .map_err(|_| "配置文件夹无法打开。".to_string())?
}

#[tauri::command]
async fn ensure_gsi(log: tauri::State<'_, DesktopLog>) -> Result<serde_json::Value, String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
        gsi_script("ensure-gsi.ps1", None, Duration::from_secs(45), &log)?;
        let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
        let result = powershell::parse(&log, "GSI 检测", &output)?;
        Ok(cs2_diagnostics::gsi_status(&result))
    })
    .await
    .map_err(|_| "GSI 自动配置未完成。".to_string())?
}

#[tauri::command]
async fn configure_gsi(app: tauri::AppHandle, restore: bool, choose: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
        let root = if choose {
            let Some(file) = app.dialog().file().blocking_pick_folder() else {
                return Ok(());
            };
            Some(file.into_path().map_err(|_| "安装目录无效。")?)
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
    })
    .await
    .map_err(|_| "GSI 配置工具未能启动。".to_string())?
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
    let managed = managed_cs2::ManagedCs2::new(log.clone());
    let mut tracker = GameTracker::default();
    tracker.overlay_enabled = true;
    tracker.preserve_settings = managed.preserve_settings();
    let running = Arc::new(AtomicBool::new(true));
    let worker = Arc::new(Mutex::new(None::<thread::JoinHandle<()>>));
    let setup_worker = worker.clone();
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
    };
    log.event("tauri_begin", "begin", None);
    let setup_log = log.clone();
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(log.clone())
        .manage(Mutex::new(managed))
        .manage(cs2_activity::Activity::default())
        .manage(production_exit::ExitGate::default())
        .manage(production_exit::VerifiedStop::default())
        .manage(updates::PendingUpdate::new(update_stage))
        .invoke_handler(tauri::generate_handler![
            restore_layout,
            restore_cs2_focus,
            set_program_overlay_enabled,
            cs2_host_status,
            select_obs_executable,
            launch_obs,
            cs2_config_status,
            start_managed_cs2,
            finish_managed_cs2,
            restore_cs2_backup,
            open_cs2_backup,
            set_cs2_preferences,
            open_main,
            present_production,
            open_tool,
            open_rivalhub_authorization,
            open_steam_api_key,
            open_issue_report,
            install_update,
            open_update_page,
            open_update_recovery,
            open_rivalhub_workbench,
            save_support_bundle,
            gsi_status,
            configure_gsi,
            ensure_gsi,
            select_cs2_installation,
            open_cs2_config_directory
        ])
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
                            hide_workspace(app);
                            if let Some(window) = app.get_webview_window("workspace-dock") {
                                let _ =
                                    window.eval("window.dispatchEvent(new Event('mizar-hide'))");
                            }
                        }
                        "open_operator" => {
                            let _ = open_main(app.clone(), None);
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
            let host = handle.clone();

            let worker_running = host.state::<HostState>().running.clone();
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
                    if let Ok(mut group) = host.state::<HostState>().window_group.lock() {
                        if let Some(failure) = workspace_group::synchronize(
                            &mut group, process.as_ref(), panels, &allowed,
                        ) {
                            if let Some(process) = &process {
                                host.state::<DesktopLog>().event(
                                    "workspace_group_restore", "failure",
                                    Some(&serde_json::json!({
                                        "stage": failure.stage, "api": failure.api,
                                        "lastError": failure.last_error,
                                        "gamePid": process.pid, "created": process.created
                                    }).to_string()),
                                );
                            }
                        }
                    }
                    // Cross-process CS2 calls stay off the Tauri main loop.
                    let (layout, rect) = if !pending.load(Ordering::Relaxed)
                        && worker_visible.load(Ordering::Relaxed)
                        && !exit_signal.requested()
                    {
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
                                (layout, tracker.overlay_rect())
                            })
                            .unwrap_or((None, None))
                    } else {
                        (None, None)
                    };
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
                                            let _ = open_main(tick_host.clone(), None);
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
                match window.label() {
                    "workspace-left" | "workspace-dock" => {
                        hide_workspace(window.app_handle());
                        if let Some(dock) = window.app_handle().get_webview_window("workspace-dock")
                        {
                            let _ = dock.eval("window.dispatchEvent(new Event('mizar-hide'))");
                        }
                        if !window
                            .state::<HostState>()
                            .tray_available
                            .load(Ordering::Relaxed)
                        {
                            let _ = open_main(window.app_handle().clone(), None);
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
                    let _activity = activity.begin(2);
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
                        || cs2.finish(),
                    )
                })
                .await
                .unwrap_or_else(|_| Err("退出收尾未完成，请重试。".into()));
                if let Err(error) = result {
                    updates::cancel(&host);
                    host.state::<DesktopLog>()
                        .event("cs2_exit_recovery", "failure", Some(&error));
                    host.state::<production_exit::ExitGate>().cancel();
                    hide_workspace(&host);
                    if host.state::<production_exit::VerifiedStop>().complete() {
                        // Direct service-stop callers may already have removed HTTP.
                        // Native recovery remains available through the tray, never a refused WebView.
                        for window in host.webview_windows().values() {
                            let _ = window.destroy();
                        }
                    } else {
                        let _ = open_main(host.clone(), Some("/".into()));
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
            windows_startup::ActivationSignal::notify();
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
            failure_dialog(&error, Some(&log.directory));
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn obs_launch_accepts_only_an_absolute_obs_executable() {
        assert!(obs_executable_allowed(Path::new(
            r"D:\OBS Studio\bin\64bit\obs64.exe"
        )));
        for path in [
            "obs64.exe",
            r"D:\OBS Studio\obs64.exe --argument",
            r"D:\OBS Studio\other.exe",
            "https://example.test/obs64.exe",
        ] {
            assert!(!obs_executable_allowed(Path::new(path)));
        }
    }

    #[test]
    fn live_settings_open_only_known_preparation_sections() {
        for path in [
            "/settings?tab=obs",
            "/settings?tab=gsi",
            "/picture?tab=overlay",
        ] {
            assert!(main_path_allowed(path));
        }
        for path in [
            "https://example.test",
            "//example.test",
            "/settings?tab=obs&redirect=https://example.test",
            "/program",
            "/../settings",
            "javascript:alert(1)",
        ] {
            assert!(!main_path_allowed(path));
        }
    }

    #[test]
    fn workbench_path_is_limited_to_one_match() {
        assert!(valid_workbench_path("/admin/rivals-2026/matches/match_1"));
        for path in [
            "/admin/rivals",
            "/admin/rivals/matches/",
            "/admin/rivals/matches/a/extra",
            "/admin/rivals/matches/%2f",
            "/integrations/mizar/connect",
        ] {
            assert!(!valid_workbench_path(path));
        }
    }

    #[test]
    fn background_gsi_scripts_emit_utf8_without_a_console() {
        let common = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/qualification/bundle/common.ps1");
        let common = common.to_string_lossy().replace('\'', "''");
        let command = format!(
            ". '{common}'; Write-Output ([string]::Concat([char]0x539f,[char]0x914d,[char]0x7f6e)); (Get-FileHash -LiteralPath '{common}' -Algorithm SHA256).Algorithm"
        );
        let root = std::env::temp_dir().join(format!("mizar-gsi-boundary-{}", std::process::id()));
        let log = DesktopLog::new(&root, None).unwrap();
        assert!(log.state_root.to_string_lossy().starts_with(r"\\?\"));
        let mut child = background_powershell();
        child.args(["-NoProfile", "-NonInteractive", "-Command", &command]);
        let output = powershell::run(child, &log, "GSI 检测回归", Duration::from_secs(20)).unwrap();
        assert_eq!(output.lines().collect::<Vec<_>>(), ["原配置", "SHA256"]);
        std::fs::remove_dir_all(root).unwrap();
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
