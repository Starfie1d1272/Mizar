#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod geometry;
mod windows_host;

use geometry::{Layout, Rect};
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use windows_host::GameTracker;
use tauri_plugin_dialog::DialogExt;

const BASE: &str = "http://127.0.0.1:3000";
static GSI_OPERATION_LOCK: Mutex<()> = Mutex::new(());

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attributes: *mut std::ffi::c_void, initial_owner: i32, name: *const u16) -> isize;
    fn GetLastError() -> u32;
    fn CloseHandle(handle: isize) -> i32;
}

struct HostState {
    tracker: Mutex<GameTracker>,
    visible: AtomicBool,
    running: AtomicBool,
}

fn bundle_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|_| "无法定位产品安装目录。".to_string())?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位产品安装目录。".to_string())
}

fn supervisor(root: &Path, argument: &str) -> Result<Child, String> {
    let node = root.join("resources/runtime/node.exe");
    let script = root.join("resources/scripts/product-runtime.mjs");
    if !node.is_file() || !script.is_file() {
        return Err("产品运行文件缺失，请重新解压完整产品包。".into());
    }
    Command::new(node)
        .arg(script)
        .arg(argument)
        .current_dir(root)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "制播服务未能启动。".into())
}

fn health_matches(root: &Path) -> bool {
    let Ok(bytes) = fs::read(root.join("resources/metadata/artifact.json")) else { return false; };
    let Ok(artifact) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false; };
    let address: SocketAddr = "127.0.0.1:3000".parse().expect("fixed loopback address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(700)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    if stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() { return false; }
    let Some(body) = response.split("\r\n\r\n").nth(1) else { return false; };
    let Ok(health) = serde_json::from_str::<serde_json::Value>(body) else { return false; };
    health["product"]["repository"] == "Starfie1d1272/Mizar"
        && health["product"]["mode"] == "product"
        && health["product"]["artifactSha256"] == artifact["artifactSha256"]
}

fn wait_for_runtime(root: &Path, child: &mut Child) -> Result<(), String> {
    let until = Instant::now() + Duration::from_secs(35);
    while Instant::now() < until {
        if health_matches(root) { return Ok(()); }
        if child.try_wait().map_err(|_| "制播服务进程异常。")?.is_some() {
            return Err("制播服务未能启动；请查看 state/logs。".into());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("制播服务启动超时；请查看 state/logs。".into())
}

fn placement(window: &tauri::WebviewWindow, rect: Rect) {
    if rect.width <= 0 || rect.height <= 0 { let _ = window.hide(); return; }
    let _ = window.set_size(PhysicalSize::new(rect.width as u32, rect.height as u32));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
}

fn apply_layout(app: &tauri::AppHandle, layout: Layout) {
    if let Some(left) = app.get_webview_window("workspace-left") { placement(&left, layout.left); }
    if let Some(dock) = app.get_webview_window("workspace-dock") { placement(&dock, layout.dock); }
}

fn update_overlay(app: &tauri::AppHandle, state: &HostState) {
    let Some(overlay) = app.get_webview_window("program-overlay") else { return; };
    let rect = if state.visible.load(Ordering::Relaxed) {
        state.tracker.lock().ok().and_then(|tracker| tracker.overlay_rect())
    } else { None };
    if let Some(rect) = rect { placement(&overlay, rect); let _ = overlay.show(); }
    else { let _ = overlay.hide(); }
}

#[tauri::command]
fn restore_layout(app: tauri::AppHandle, state: tauri::State<'_, HostState>) -> Result<(), String> {
    let layout = state.tracker.lock().map_err(|_| "桌面窗口状态不可用。")?.restore_layout()
        .ok_or_else(|| "无法读取显示器工作区。".to_string())?;
    apply_layout(&app, layout);
    update_overlay(&app, &state);
    Ok(())
}

#[tauri::command]
fn restore_cs2_focus(state: tauri::State<'_, HostState>) -> bool {
    state.tracker.lock().is_ok_and(|tracker| tracker.restore_focus())
}

#[tauri::command]
fn set_program_overlay_enabled(app: tauri::AppHandle, state: tauri::State<'_, HostState>, enabled: bool) -> Result<(), String> {
    state.tracker.lock().map_err(|_| "桌面窗口状态不可用。")?.overlay_enabled = enabled;
    update_overlay(&app, &state);
    Ok(())
}

#[tauri::command]
fn cs2_host_status(state: tauri::State<'_, HostState>) -> serde_json::Value {
    match state.tracker.lock() {
        Ok(tracker) => serde_json::json!({ "found": tracker.window.is_some(), "managed": tracker.managed, "generation": tracker.generation }),
        Err(_) => serde_json::json!({ "found": false, "managed": false, "generation": 0 }),
    }
}

#[tauri::command]
async fn select_obs_executable(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().add_filter("OBS Studio", &["exe"]).blocking_pick_file()
    }).await.map_err(|_| "文件选择器未能打开。".to_string())?;
    let Some(file) = picked else { return Ok(None); };
    let path = file.into_path().map_err(|_| "无法读取所选文件路径。".to_string())?;
    if path.file_name().and_then(|name| name.to_str()).is_none_or(|name| !name.eq_ignore_ascii_case("obs64.exe")) || !path.is_file() {
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
        if let Some(window) = app.get_webview_window(label) { let _ = window.show(); }
    }
    update_overlay(app, &state);
}

fn hide_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.visible.store(false, Ordering::Relaxed);
    for label in ["workspace-left", "workspace-dock", "program-overlay"] {
        if let Some(window) = app.get_webview_window(label) { let _ = window.hide(); }
    }
}

#[tauri::command]
fn open_main(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let path = path.unwrap_or_else(|| "/".into());
    if !["/", "/matches", "/matches?tab=roster", "/picture", "/settings"]
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
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn present_production(app: tauri::AppHandle, live: bool) {
    if live {
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
}

#[tauri::command]
fn open_tool(app: tauri::AppHandle, tool: String) -> Result<(), String> {
    let (label, title, path) = match tool.as_str() {
        "hud" => ("tool-hud", "HUD 工作台", "/operator/hud"),
        "bp" => ("tool-bp", "BP 工作台", "/operator/bp"),
        "diagnostics" => ("tool-diagnostics", "运行诊断", "/debug"),
        "preview" => ("tool-preview", "节目预览", "/preview"),
        _ => return Err("工具无法识别。".into()),
    };
    if let Some(window) = app.get_webview_window(label) {
        window.navigate(format!("{BASE}{path}").parse().map_err(|_| "工具地址无法识别。")?)
            .map_err(|_| "工具窗口未能恢复。")?;
        let _ = window.show();
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
        .arg(bundle.join("resources/scripts").join(name)).current_dir(&bundle);
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
        if child.try_wait().map_err(|_| "GSI 配置读取失败。")?.is_some() { break; }
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

fn run_desktop(root: PathBuf) -> Result<(), String> {
    let mut tracker = GameTracker::default();
    tracker.overlay_enabled = true;
    let state = HostState {
        tracker: Mutex::new(tracker),
        visible: AtomicBool::new(false),
        running: AtomicBool::new(true),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            restore_layout,
            restore_cs2_focus,
            set_program_overlay_enabled,
            cs2_host_status,
            select_obs_executable,
            open_main,
            present_production,
            open_tool,
            gsi_status,
            configure_gsi
        ])
        .setup(move |app| {
            let handle = app.handle();
            WebviewWindowBuilder::new(handle, "main", local_url("/"))
                .title("Mizar")
                .inner_size(1280.0, 860.0)
                .min_inner_size(720.0, 560.0)
                .visible(true)
                .on_navigation(trusted_navigation)
                .build()?;
            let left = WebviewWindowBuilder::new(handle, "workspace-left", local_url("/workspace/left"))
                .title("Mizar · 工作区")
                .decorations(false).resizable(false).visible(false).focused(false).on_navigation(trusted_navigation).build()?;
            let dock = WebviewWindowBuilder::new(handle, "workspace-dock", local_url("/workspace/dock"))
                .title("Mizar · 现场控制")
                .decorations(false).resizable(false).visible(false).focused(false).on_navigation(trusted_navigation).build()?;
            let overlay = WebviewWindowBuilder::new(handle, "program-overlay", local_url("/program?host=desktop"))
                .title("Mizar · Program HUD")
                .decorations(false).resizable(false).transparent(true).always_on_top(true)
                .focusable(false).focused(false).skip_taskbar(true).visible(false)
                .on_navigation(trusted_navigation).build()?;
            overlay.set_ignore_cursor_events(true)?;
            overlay.set_content_protected(true)?;
            left.set_content_protected(true)?;
            dock.set_content_protected(true)?;
            let open = MenuItem::with_id(handle, "open_workspace", "打开 / 恢复制播工作区", true, None::<&str>)?;
            let control = MenuItem::with_id(handle, "open_operator", "打开 Mizar", true, None::<&str>)?;
            let exit = MenuItem::with_id(handle, "exit", "退出 Mizar", true, None::<&str>)?;
            let hide = MenuItem::with_id(handle, "hide_workspace", "隐藏制播工作区", true, None::<&str>)?;
            let menu = Menu::with_items(handle, &[&control, &open, &hide, &exit])?;
            TrayIconBuilder::new().icon(tauri::include_image!("./icons/tray-icon.png")).menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open_workspace" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.eval("window.dispatchEvent(new Event('mizar-enter'))");
                        }
                    }
                    "hide_workspace" => {
                        hide_workspace(app);
                        if let Some(window) = app.get_webview_window("workspace-dock") {
                            let _ = window.eval("window.dispatchEvent(new Event('mizar-hide'))");
                        }
                    }
                    "open_operator" => {
                        let _ = open_main(app.clone(), None);
                    }
                    "exit" => {
                        let state = app.state::<HostState>();
                        state.running.store(false, Ordering::Relaxed);
                        if let Ok(mut child) = supervisor(&root, "--stop") { let _ = child.wait(); }
                        app.exit(0);
                    },
                    _ => (),
                }).build(handle)?;
            let host = handle.clone();

            thread::spawn(move || {
                while host.state::<HostState>().running.load(Ordering::Relaxed) {
                    if !host.state::<HostState>().visible.load(Ordering::Relaxed) { thread::sleep(Duration::from_millis(250)); continue; }
                    let layout = host.state::<HostState>().tracker.lock().ok().and_then(|mut tracker| tracker.tick());
                    if let Some(layout) = layout { apply_layout(&host, layout); }
                    update_overlay(&host, &host.state::<HostState>());
                    thread::sleep(Duration::from_millis(250));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                match window.label() {
                    "workspace-left" | "workspace-dock" => {
                        hide_workspace(window.app_handle());
                        if let Some(dock) = window.app_handle().get_webview_window("workspace-dock") {
                            let _ = dock.eval("window.dispatchEvent(new Event('mizar-hide'))");
                        }
                    }
                    _ => {
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .map_err(|_| "桌面工作区启动失败。".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg != "--stop" && arg != "--no-browser") {
        eprintln!("启动参数无法识别。"); std::process::exit(1);
    }
    let root = match bundle_root() { Ok(root) => root, Err(message) => { eprintln!("{message}"); std::process::exit(1); } };
    if args.iter().any(|arg| arg == "--stop") {
        let status = supervisor(&root, "--stop").and_then(|mut child| child.wait().map_err(|_| "退出操作失败。".to_string()));
        if !matches!(status, Ok(exit) if exit.success()) { std::process::exit(1); }
        return;
    }
    let headless = args.iter().any(|arg| arg == "--no-browser");
    let mutex = if headless { 0 } else {
        let name: Vec<u16> = "Global\\MizarDesktop\0".encode_utf16().collect();
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle == 0 { eprintln!("桌面工作区锁不可用。"); std::process::exit(1); }
        if unsafe { GetLastError() } == 183 { return; }
        handle
    };
    let outcome = (|| {
        let mut child = supervisor(&root, "--no-browser")?;
        wait_for_runtime(&root, &mut child)?;
        if headless {
            return child.wait().map_err(|_| "制播服务进程异常。".to_string()).and_then(|status| if status.success() { Ok(()) } else { Err("制播服务异常退出。".into()) });
        }
        run_desktop(root)
    })();
    if mutex != 0 { unsafe { CloseHandle(mutex); } }
    if let Err(message) = outcome { eprintln!("{message}"); std::process::exit(1); }
}
