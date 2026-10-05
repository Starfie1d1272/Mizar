#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod geometry;
mod startup_log;
mod startup_wait;
mod support_export;
mod windows_host;
mod windows_startup;

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
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use windows_host::GameTracker;
use windows_startup::{failure_dialog, DesktopMutex, ExitSignal, RuntimeJob};

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
    running: Arc<AtomicBool>,
    live_window_lock: Mutex<()>,
    tray_available: AtomicBool,
}

struct DesktopWorker {
    running: Arc<AtomicBool>,
    dispatch: Arc<Mutex<()>>,
    handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}
impl DesktopWorker {
    fn stop(&self) {
        if let Ok(_dispatch) = self.dispatch.lock() {
            self.running.store(false, Ordering::Relaxed);
        }
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(handle) = handle.take() {
                let until = Instant::now() + Duration::from_millis(300);
                while !handle.is_finished() && Instant::now() < until {
                    thread::sleep(Duration::from_millis(10));
                }
                if handle.is_finished() {
                    let _ = handle.join();
                }
                // A blocked CS2 native call may finish later. The dispatch gate
                // prevents this detached worker from using Tauri after shutdown.
            }
        }
    }
}
impl Drop for DesktopWorker {
    fn drop(&mut self) {
        self.stop();
    }
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
    if rect.width <= 0 || rect.height <= 0 {
        let _ = window.hide();
        return;
    }
    let _ = window.set_size(PhysicalSize::new(rect.width as u32, rect.height as u32));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
}

fn apply_layout(app: &tauri::AppHandle, layout: Layout) {
    if let Some(left) = app.get_webview_window("workspace-left") {
        placement(&left, layout.left);
    }
    if let Some(dock) = app.get_webview_window("workspace-dock") {
        placement(&dock, layout.dock);
    }
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
        let _ = overlay.show();
    } else {
        let _ = overlay.hide();
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
    Ok(())
}

#[tauri::command]
fn restore_cs2_focus(state: tauri::State<'_, HostState>) -> bool {
    state
        .tracker
        .lock()
        .is_ok_and(|tracker| tracker.restore_focus())
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
            serde_json::json!({ "found": tracker.window.is_some(), "managed": tracker.managed, "generation": tracker.generation })
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

fn trusted_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(3000)
}

fn show_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.visible.store(true, Ordering::Relaxed);
    for label in ["workspace-left", "workspace-dock"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    update_overlay(app, &state);
}

fn hide_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.visible.store(false, Ordering::Relaxed);
    for label in ["workspace-left", "workspace-dock", "program-overlay"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
}

#[tauri::command]
fn open_main(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let path = path.unwrap_or_else(|| "/".into());
    if ![
        "/",
        "/matches",
        "/matches?tab=roster",
        "/picture",
        "/settings",
    ]
    .contains(&path.as_str())
    {
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
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn present_production(app: tauri::AppHandle, live: bool) -> Result<(), String> {
    if live {
        ensure_live_windows(&app).map_err(|error| {
            format!("现场窗口未能打开，准备中心仍可使用。请打开运行日志后重试。\n{error}")
        })?;
        let state = app.state::<HostState>();
        if let Some(layout) = state
            .tracker
            .lock()
            .ok()
            .and_then(|mut tracker| tracker.restore_layout())
        {
            apply_layout(&app, layout);
        }
        show_workspace(&app);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
    } else {
        hide_workspace(&app);
        let _ = open_main(app, None);
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
        let left = log.step("workspace_left", || {
            WebviewWindowBuilder::new(app, "workspace-left", local_url("/workspace/left"))
                .title("Mizar · 工作区")
                .decorations(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .on_navigation(trusted_navigation)
                .build()
        })?;
        let dock = log.step("workspace_dock", || {
            WebviewWindowBuilder::new(app, "workspace-dock", local_url("/workspace/dock"))
                .title("Mizar · 现场控制")
                .decorations(false)
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
        log.step("content_protection", || -> tauri::Result<()> {
            overlay.set_ignore_cursor_events(true)?;
            overlay.set_content_protected(true)?;
            left.set_content_protected(true)?;
            dock.set_content_protected(true)
        })?;
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
        let _ = window.show();
        let _ = window.unminimize();
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

fn gsi_script(name: &str, root: Option<&Path>, timeout: Duration) -> Result<String, String> {
    let bundle = bundle_root()?;
    let mut command = Command::new("powershell.exe");
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
        command.arg("-Cs2Root").arg(path);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "GSI 配置工具未能启动。")?;
    let deadline = Instant::now() + timeout;
    loop {
        if child
            .try_wait()
            .map_err(|_| "GSI 配置读取失败。")?
            .is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("GSI 操作超时；请重新检测状态后再试。".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let output = child.wait_with_output().map_err(|_| "GSI 配置读取失败。")?;
    if !output.status.success() {
        return Err("GSI 配置未完成；请核对安装目录与配置冲突后重试。".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "GSI 状态读取失败。".into())
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
async fn gsi_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
        let result: serde_json::Value = serde_json::from_str(&gsi_script(
            "gsi-status.ps1",
            None,
            Duration::from_secs(20),
        )?)
        .map_err(|_| "GSI 状态无法识别。")?;
        // Explicit allowlist: installation records contain secrets and never cross IPC.
        Ok(serde_json::json!({
            "detected": result["detected"] == true,
            "installed": result["installed"] == true,
            "conflict": result["conflict"] == true,
            "fileConflict": result["fileConflict"] == true,
            "endpointConflict": result["endpointConflict"] == true,
            "cfgPath": result["cfgPath"].as_str()
        }))
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
) -> Result<(), String> {
    let activation = windows_startup::ActivationSignal::new()
        .map_err(|_| "无法建立桌面窗口恢复信号。".to_string())?;
    let mut tracker = GameTracker::default();
    tracker.overlay_enabled = true;
    let running = Arc::new(AtomicBool::new(true));
    let worker = Arc::new(Mutex::new(None::<thread::JoinHandle<()>>));
    let setup_worker = worker.clone();
    let dispatch = Arc::new(Mutex::new(()));
    let setup_dispatch = dispatch.clone();
    let state = HostState {
        tracker: Arc::new(Mutex::new(tracker)),
        visible: Arc::new(AtomicBool::new(false)),
        running: running.clone(),
        live_window_lock: Mutex::new(()),
        tray_available: AtomicBool::new(false),
    };
    log.event("tauri_begin", "begin", None);
    let setup_log = log.clone();
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(log.clone())
        .invoke_handler(tauri::generate_handler![
            restore_layout,
            restore_cs2_focus,
            set_program_overlay_enabled,
            cs2_host_status,
            select_obs_executable,
            open_main,
            present_production,
            open_tool,
            open_rivalhub_authorization,
            open_rivalhub_workbench,
            save_support_bundle,
            gsi_status,
            configure_gsi
        ])
        .setup(move |app| {
            let handle = app.handle();
            let page_log = setup_log.clone();
            setup_log.step("main_window", || {
                WebviewWindowBuilder::new(handle, "main", local_url("/"))
                    .title("Mizar")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(720.0, 560.0)
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
                                let _ = window.show();
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
                            let state = app.state::<HostState>();
                            state.running.store(false, Ordering::Relaxed);
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
            let pending = Arc::new(AtomicBool::new(false));
            let worker = thread::spawn(move || {
                while worker_running.load(Ordering::Relaxed) {
                    // Cross-process CS2 calls stay off the Tauri main loop.
                    let (layout, rect) =
                        if worker_visible.load(Ordering::Relaxed) && !exit_signal.requested() {
                            worker_tracker
                                .lock()
                                .ok()
                                .map(|mut tracker| (tracker.tick(), tracker.overlay_rect()))
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
                        let tick_host = host.clone();
                        let tick_running = worker_running.clone();
                        let tick_pending = pending.clone();
                        let tick_signal = exit_signal.clone();
                        if host
                            .run_on_main_thread(move || {
                                if tick_running.load(Ordering::Relaxed) {
                                    if tick_signal.requested() {
                                        tick_host.state::<DesktopLog>().event(
                                            "runtime_stopped",
                                            "success",
                                            Some("Explicit verified stop completed."),
                                        );
                                        tick_running.store(false, Ordering::Relaxed);
                                        tick_host.exit(0);
                                    } else {
                                        if activate {
                                            let _ = open_main(tick_host.clone(), None);
                                        }
                                        if tick_host
                                            .state::<HostState>()
                                            .visible
                                            .load(Ordering::Relaxed)
                                        {
                                            if let Some(layout) = layout {
                                                apply_layout(&tick_host, layout);
                                            }
                                            present_overlay(&tick_host, rect);
                                        } else {
                                            present_overlay(&tick_host, None);
                                        }
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
    let ready_error = ready_error.lock().ok().and_then(|mut error| error.take());
    if let Some(error) = ready_error {
        Err(error)
    } else if exit_code == 0 {
        Ok(())
    } else {
        Err(format!("桌面界面异常退出（{exit_code}）；请查看运行日志。"))
    }
}

fn start_gui(root: &Path, log: &DesktopLog) -> Result<(), String> {
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
            run_desktop(log.clone(), exit_signal, job.clone())
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
        let _ = log.step("runtime_stop", || stop_runtime(root, Some(log)));
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
        return outcome.and(Err(error));
    }
    log.event(cleanup_stage, "success", None);
    outcome
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
    if let Err(error) = start_gui(&root, &log) {
        log.event("startup_failed", "failure", Some(&error));
        failure_dialog(&error, Some(&log.directory));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod startup_tests {
    use super::*;

    #[test]
    fn workbench_path_is_limited_to_one_match() {
        assert!(valid_workbench_path("/admin/rivals-2026/matches/match_1"));
        for path in ["/admin/rivals", "/admin/rivals/matches/", "/admin/rivals/matches/a/extra", "/admin/rivals/matches/%2f", "/integrations/mizar/connect"] {
            assert!(!valid_workbench_path(path));
        }
    }

    #[test]
    fn background_gsi_scripts_emit_utf8_without_a_console() {
        let common = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/qualification/bundle/common.ps1");
        let common = common.to_string_lossy().replace('\'', "''");
        let command = format!(
            ". '{common}'; Write-Output ([string]::Concat([char]0x539f,[char]0x914d,[char]0x7f6e))"
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .stdin(Stdio::null())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "原配置");
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
