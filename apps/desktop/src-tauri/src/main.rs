#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cs2_activity;
mod cs2_config_identity;
mod cs2_console;
mod cs2_diagnostics;
mod cs2_frame_rate;
mod cs2_frame_rate_live;
mod cs2_host;
mod cs2_preferences;
mod cs2_process;
mod cs2_process_identity;
mod cs2_session;
mod cs2_session_record;
mod cs2_spectator;
mod cs2_video;
mod demo_host;
mod demo_test;
mod desktop_commands;
mod desktop_ipc;
mod desktop_types;
mod desktop_worker;
mod entry_intent;
mod geometry;
mod gsi_host;
mod host_runtime;
mod host_state;
#[path = "../ipc_contract.rs"]
mod ipc_contract;
mod lifecycle_contract;
mod managed_cs2;
mod mulnx_launch;
mod mulnx_stop;
mod obs_configuration;
mod observer_hud;
mod observer_job;
mod observer_workspace;
mod overlay_recovery;
mod powershell;
mod preparation_evidence;
mod preparation_gate;
mod preparation_task;
mod production_exit;
mod spectator_recovery_plan;
mod spectator_recovery_vcfg;
mod spectator_snapshot;
mod startup_log;
mod startup_recovery;
mod startup_wait;
mod support_export;
mod updates;
mod window_frame;
mod window_presentation;
mod windows_host;
mod windows_startup;
mod workspace_focus;
mod workspace_group;
mod workspace_presentation;
mod workspace_shell;

use desktop_worker::DesktopWorker;
use entry_intent::EntryIntent;
use host_state::HostState;
use startup_log::DesktopLog;
use std::{
    fs,
    hash::{Hash, Hasher},
    io::Write,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use windows_host::GameTracker;
use windows_startup::{failure_dialog, DesktopMutex, ExitRequest, ExitSignal, RuntimeJob};

fn supervisor(
    root: &Path,
    argument: &str,
    startup: Option<&DesktopLog>,
    expected_instance: Option<&str>,
) -> Result<Child, String> {
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
    if let Some(instance) = expected_instance {
        command.env("MIZAR_EXPECTED_RUNTIME_INSTANCE", instance);
    } else {
        command.env_remove("MIZAR_EXPECTED_RUNTIME_INSTANCE");
    }
    if let Some(log) = startup {
        command
            .env("MIZAR_STARTUP_SESSION_ID", &log.session_id)
            .env("MIZAR_STATE_ROOT", &log.state_root)
            .env("MIZAR_DESKTOP_SUPERVISED", "1")
            .env("MIZAR_OBSERVER_JOB", observer_job::name(&log.session_id))
            .env(
                "MIZAR_OBSERVER_HOST",
                std::env::current_exe().map_err(|e| e.to_string())?,
            );
    }
    command
        .spawn()
        .map_err(|error| format!("制播服务未能启动：{error:?}"))
}

fn wait_for_runtime(
    root: &Path,
    child: &mut Child,
    log: Option<&DesktopLog>,
) -> Result<(), String> {
    let mut wait = startup_wait::StartupWait::new(Instant::now());
    loop {
        if host_runtime::health_matches(root) {
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

fn stop_runtime(
    root: &Path,
    log: Option<&DesktopLog>,
    expected_instance: &str,
) -> Result<(), String> {
    let mut child = supervisor(root, "--stop", None, Some(expected_instance))?;
    match wait_child(&mut child, Duration::from_secs(300)) {
        Ok(status) if status.success() => {
            if let Ok(scope) = shutdown_scope(root) {
                ExitSignal::notify_stopped(&scope);
            }
            Ok(())
        }
        outcome => {
            // An outer timeout could be payload verification, not Companion
            // shutdown. Only the stop helper's own exit code proves the latter.
            let timed_out = matches!(&outcome, Ok(status) if status.code() == Some(2));
            if outcome.is_err() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let error = format!(
                "{}：{outcome:?}",
                if timed_out {
                    "runtime_stop_timeout: 制播服务退出未完成"
                } else {
                    "runtime_stop_failed: 制播服务退出未完成"
                }
            );
            if let Some(log) = log {
                log.event("runtime_stop", "failure", Some(&error));
            }
            Err(error)
        }
    }
}

struct RuntimeStopTarget {
    receipt: PathBuf,
    host_receipt: PathBuf,
    instance: String,
    artifact: String,
    pid: u64,
}

fn runtime_stop_target(root: &Path, require_pending: bool) -> Result<RuntimeStopTarget, String> {
    let state_root = startup_log::writable_root(
        root,
        std::env::var_os("MIZAR_STATE_ROOT").map(PathBuf::from),
    )
    .map_err(|error| error.to_string())?;
    let state: serde_json::Value = serde_json::from_slice(
        &fs::read(state_root.join("data/runtime.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let artifact: serde_json::Value = serde_json::from_slice(
        &fs::read(root.join("resources/metadata/artifact.json"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let instance = state["instanceId"]
        .as_str()
        .filter(|id| id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
        .ok_or("运行实例身份无效。")?;
    let digest = state["artifactSha256"]
        .as_str()
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("运行资源身份无效。")?;
    if state["repository"] != "Starfie1d1272/Mizar" || artifact["artifactSha256"] != digest {
        return Err("运行实例与此程序不匹配。".into());
    }
    let pid = state["pid"]
        .as_u64()
        .filter(|pid| *pid > 0)
        .ok_or("运行进程身份无效。")?;
    let receipt = state_root
        .join("data")
        .join(format!("runtime-exit-{instance}.json"));
    if require_pending && receipt.exists() {
        return Err("运行实例已退出，请等待桌面状态更新后重试。".into());
    }
    let host_receipt = state_root
        .join("data")
        .join(format!("runtime-host-exit-{instance}.json"));
    Ok(RuntimeStopTarget {
        receipt,
        host_receipt,
        instance: instance.into(),
        artifact: digest.into(),
        pid,
    })
}

fn runtime_stop_receipt(target: &RuntimeStopTarget) -> Result<bool, String> {
    let bytes = match fs::read(&target.receipt) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("退出记录读取失败：{error}")),
    };
    let receipt: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if receipt["instanceId"] != target.instance
        || receipt["pid"].as_u64() != Some(target.pid)
        || receipt["artifactSha256"] != target.artifact
        || receipt["code"].as_i64() != Some(0)
        || !receipt["signal"].is_null()
        || receipt["error"] != false
        || receipt["localComplete"] != true
    {
        return Err("运行实例退出或本地收尾未确认。".into());
    }
    Ok(true)
}

fn write_host_stop_receipt(target: &RuntimeStopTarget) -> Result<(), String> {
    if !runtime_stop_receipt(target)? {
        return Err("制播进程退出尚未确认。".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = target
        .host_receipt
        .with_extension(format!("{}-{nonce}.tmp", std::process::id()));
    let body = serde_json::to_vec(&serde_json::json!({
        "instanceId": target.instance,
        "artifactSha256": target.artifact,
        "pid": target.pid,
    }))
    .map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&body).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, &target.host_receipt).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn host_stop_receipt(target: &RuntimeStopTarget) -> Result<bool, String> {
    let bytes = match fs::read(&target.host_receipt) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("桌面退出记录读取失败：{error}")),
    };
    let receipt: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if receipt["instanceId"] != target.instance
        || receipt["pid"].as_u64() != Some(target.pid)
        || receipt["artifactSha256"] != target.artifact
    {
        return Err("桌面退出实例身份不匹配。".into());
    }
    Ok(true)
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

fn run_desktop(
    log: DesktopLog,
    exit_signal: ExitSignal,
    job: Arc<RuntimeJob>,
    pending_update: updates::PendingUpdate,
) -> Result<(), String> {
    // Bind before publishing this GUI or accepting any renderer command.
    let pending_update = pending_update.for_gui();
    let exit_request = Arc::new(
        ExitRequest::new(&shutdown_scope(&host_runtime::bundle_root()?)?)
            .map_err(|error| error.to_string())?,
    );
    let activation = windows_startup::ActivationSignal::new()
        .map_err(|_| "无法建立桌面窗口恢复信号。".to_string())?;
    // A retained Companion must revoke the previous Host before any UI can reconnect.
    production_exit::camera_session(&log, "host-start", None, None)?;
    let managed = managed_cs2::ManagedCs2::new(log.clone());
    let camera_state = managed.camera_state();
    let mut tracker = GameTracker::default();
    tracker.overlay_enabled = true;
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
        panels_only: AtomicBool::new(false),
        entry_ticket: Mutex::new(None),
        entry_message: Mutex::new(String::new()),
        layout_dirty: Arc::new(AtomicBool::new(false)),
        layout_request: AtomicU64::new(0),
        layout_request_generation: AtomicU64::new(0),
        layout_completed: AtomicU64::new(0),
        running: running.clone(),
        live_window_lock: Mutex::new(()),
        overlay_generation: AtomicU64::new(0),
        overlay_ready: AtomicU64::new(0),
        overlay_epoch: AtomicU64::new(0),
        overlay_recovering: AtomicBool::new(false),
        overlay_presentation: Mutex::new(()),
        workspace_epoch: AtomicU64::new(0),
        overlay_observation: Mutex::new(String::new()),
        overlay_document: AtomicU64::new(0),
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
        .manage(EntryIntent::default())
        .manage(production_exit::WorkspaceExit::default())
        .manage(production_exit::VerifiedStop::default())
        .manage(preparation_gate::PreparationGate::default())
        .manage(pending_update.clone())
        .invoke_handler(|invoke| {
            let command = invoke.message.command();
            if !["gsi_status", "cs2_host_status", "cs2_config_status", "cs2_console_status", "workspace_exit_status", "preparation_status", "read_obs_configuration_context", "save_support_bundle", "persist_diagnostic_events", "diagnostic_pin"].contains(&command) {
                let log = invoke.message.webview_ref().state::<DesktopLog>();
                let payload = match invoke.message.payload() {
                    tauri::ipc::InvokeBody::Json(value) => value.clone(),
                    tauri::ipc::InvokeBody::Raw(bytes) => serde_json::json!({"binaryBytes":bytes.len()}),
                };
                log.event("native_command", "begin", Some(&serde_json::json!({"command":command,"window":invoke.message.webview_ref().label(),"parameters":payload}).to_string()));
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                include!(concat!(env!("OUT_DIR"), "/ipc_handler.rs"));
            handler(invoke)
        })
        .setup(move |app| {
            let handle = app.handle();
            let page_log = setup_log.clone();
            setup_log.step("main_window", || {
                WebviewWindowBuilder::new(handle, "main", workspace_presentation::local_url("/"))
                    .title("Mizar")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(720.0, 560.0)
                    .maximized(true)
                    .visible(true)
                    .on_navigation(workspace_presentation::trusted_navigation)
                    .on_page_load(move |window, payload| {
                        if payload.event() == tauri::webview::PageLoadEvent::Started {
                            window.state::<EntryIntent>().cancel_all();
                            obs_configuration::document_changed(&page_log);
                        }
                        if payload.event() == tauri::webview::PageLoadEvent::Finished
                            && workspace_presentation::trusted_navigation(payload.url())
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
                            let _ = workspace_presentation::hide_workspace(app);
                            if let Some(window) = app.get_webview_window("workspace-dock") {
                                let _ =
                                    window.eval("window.dispatchEvent(new Event('mizar-hide'))");
                            }
                        }
                        "open_operator" => {
                            let _ = workspace_presentation::open_main(app.clone(), None, None);
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
            if tray.is_err() {
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.set_title("Mizar · 托盘不可用");
                }
            }
            setup_log.event("setup_complete", "success", None);
            updates::check_on_startup(handle.clone());
            let host = handle.clone();

            let worker_running = host.state::<HostState>().running.clone();
            let observer_running = worker_running.clone();
            let observer_host = host.clone();
            thread::spawn(move || {
                while observer_running.load(Ordering::Acquire) {
                    observer_workspace::pulse(&observer_host);
                    thread::sleep(Duration::from_secs(2));
                }
            });
            let camera_running = worker_running.clone();
            let camera_log = setup_log.clone();
            thread::spawn(move || {
                while camera_running.load(Ordering::Acquire) {
                    managed_cs2::pulse_camera(&camera_state, &camera_log);
                    thread::sleep(Duration::from_secs(2));
                }
            });
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
                let mut exit_generation = host.state::<production_exit::ExitGate>().generation();
                let mut retired_workspace = None;
                while worker_running.load(Ordering::Relaxed) {
                    let next_exit = host.state::<production_exit::ExitGate>().generation();
                    if next_exit != exit_generation {
                        if let Ok(mut tracker) = worker_tracker.lock() {
                            if let Err(error) = tracker.retire_layout() {
                                host.state::<DesktopLog>().event("cs2_window_retire", "failure", Some(&format!("SetWindowPos: {error}")));
                            }
                            exit_generation = next_exit;
                            retired_workspace = Some(host.state::<HostState>().workspace_epoch.load(Ordering::Acquire));
                            if host.state::<HostState>().layout_request_generation.load(Ordering::Acquire) != next_exit {
                                worker_layout_dirty.store(false, Ordering::Release);
                                if host.state::<HostState>().layout_request_generation.load(Ordering::Acquire) == next_exit {
                                    worker_layout_dirty.store(true, Ordering::Release);
                                }
                            }
                        }
                    }
                    if retired_workspace.is_some_and(|epoch| epoch != host.state::<HostState>().workspace_epoch.load(Ordering::Acquire))
                        || (worker_layout_dirty.load(Ordering::Acquire)
                            && host.state::<HostState>().layout_request_generation.load(Ordering::Acquire) == exit_generation
                            && host.state::<production_exit::ExitGate>().check().is_ok())
                    {
                        retired_workspace = None;
                    }
                    if cs2_check.elapsed() >= Duration::from_secs(2) {
                        if let Some(_operation) = observer_workspace::try_operation() {
                          if let Ok(mut cs2) = host.state::<Mutex<managed_cs2::ManagedCs2>>().try_lock() {
                            cs2.poll();
                            workspace_presentation::refresh_finished_window_feedback(&host, &cs2);
                            if let Ok(mut tracker) = worker_tracker.lock() {
                                tracker.set_owner(cs2.workspace_process().ok().flatten());
                            }
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
                            && !host.state::<HostState>().panels_only.load(Ordering::Acquire)
                            && !exit_signal.requested()
                            && host.state::<production_exit::ExitGate>().check().is_ok()
                            && host.state::<cs2_activity::Activity>().phase() == "idle"
                            && retired_workspace.is_none()
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
                            &mut group, process.as_ref(), panels, &allowed,
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
                    let workspace_epoch = host.state::<HostState>().workspace_epoch.load(Ordering::Acquire);
                    let overlay_epoch = host.state::<HostState>().overlay_epoch.load(Ordering::Acquire);
                    let (layout, rect) = if !pending.load(Ordering::Relaxed)
                        && worker_visible.load(Ordering::Relaxed)
                        && !host.state::<HostState>().panels_only.load(Ordering::Acquire)
                        && !exit_signal.requested()
                        && allowed()
                    {
                        let workspace_windows = workspace_presentation::overlay_workspace_windows(&host);
                        worker_tracker
                            .lock()
                            .ok()
                            .map(|mut tracker| {
                                // A DPI change can resize a WebView without changing CS2's
                                // physical client or DPI. Reapply the shared physical layout
                                // after the native suggested-size handler has completed.
                                let request = host.state::<HostState>().layout_request.load(Ordering::Acquire);
                                let layout = if worker_layout_dirty.swap(false, Ordering::AcqRel) {
                                    let result = tracker.restore_layout();
                                    if result.is_some() && host.state::<HostState>().workspace_epoch.load(Ordering::Acquire) == workspace_epoch && allowed() {
                                        host.state::<HostState>().layout_completed.store(request, Ordering::Release);
                                    }
                                    result
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
                                            let _ = workspace_presentation::open_main(tick_host.clone(), None, None);
                                        }
                                        workspace_presentation::sync_workspace_shell(&tick_host);
                                        if tick_host.state::<HostState>().visible.load(Ordering::Acquire)
                                            && tick_host.state::<HostState>().workspace_epoch.load(Ordering::Acquire) == workspace_epoch
                                            && tick_host.state::<production_exit::ExitGate>().check().is_ok()
                                        {
                                            if let Some(layout) = layout {
                                                workspace_presentation::apply_layout(&tick_host, layout);
                                            }
                                            workspace_presentation::present_overlay(&tick_host, rect, overlay_epoch);
                                        } else {
                                            workspace_presentation::present_overlay(&tick_host, None, overlay_epoch);
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
                    window.state::<EntryIntent>().cancel_all();
                }
                match window.label() {
                    "tool-review" => { let _ = window.destroy(); }
                    "main" | "workspace-left" | "workspace-dock" => window.app_handle().exit(0),
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
        running: running.clone(),
        dispatch: Arc::new(Mutex::new(())),
        handle: console_worker,
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
                Ok(()) => {
                    log.event("host_loop_ready", "success", None);
                    if let Err(error) = windows_startup::acknowledge_update_start() {
                        log.event(
                            "update_start_acknowledgement",
                            "failure",
                            Some(&error.to_string()),
                        );
                    }
                }
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
            let done = exit_cleanup_done.clone();
            let host = app.clone();
            // Gate acquisition can wait for an accepted publication. Never wait on the UI loop.
            tauri::async_runtime::spawn(async move {
                let gate_host = host.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    gate_host.state::<production_exit::ExitGate>().begin()
                })
                .await
                {
                    Ok(true) => (),
                    Ok(false) => return,
                    Err(error) => {
                        host.state::<DesktopLog>().event(
                            "workspace_exit",
                            "failure",
                            Some(&format!("gate task: {error}")),
                        );
                        host.dialog()
                            .message("退出任务未能开始，请重试并查看运行日志。")
                            .title("Mizar 退出未完成")
                            .show(|_| {});
                        return;
                    }
                }
                let cleanup_host = host.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    updates::recheck(&cleanup_host)?;
                    // The gate is already closed; wait for an accepted launch,
                    // then keep its lock through safe production and game cleanup.
                    let _operation = observer_workspace::cleanup_operation();
                    let state = cleanup_host.state::<Mutex<managed_cs2::ManagedCs2>>();
                    let mut cs2 = state.lock().map_err(|_| "CS2 配置状态不可用。")?;
                    let service_stopped = cleanup_host
                        .state::<production_exit::VerifiedStop>()
                        .complete();
                    let exit_intent = if service_stopped {
                        Ok(())
                    } else {
                        production_exit::set_exit_intent(
                            &cleanup_host.state::<DesktopLog>(),
                            "begin-exit",
                        )
                    };
                    let production_host = cleanup_host.clone();
                    let production_task = std::thread::spawn(move || {
                        if service_stopped {
                            Ok(())
                        } else {
                            production_exit::finish_companion(
                                &production_host.state::<DesktopLog>(),
                            )
                        }
                    });
                    let activity = cleanup_host.state::<cs2_activity::Activity>();
                    let _activity = activity.begin(2);
                    let cleanup = production_exit::restore_then_cleanup(
                        || {
                            if cleanup_host
                                .state::<production_exit::VerifiedStop>()
                                .complete()
                            {
                                observer_hud::restore(&cleanup_host.state::<DesktopLog>())
                            } else {
                                observer_workspace::finish_locked(
                                    &cleanup_host.state::<DesktopLog>(),
                                )
                            }
                        },
                        || {
                            let service_stopped = cleanup_host
                                .state::<production_exit::VerifiedStop>()
                                .complete();
                            if service_stopped {
                                cs2.finish_with_service_stopped(service_stopped)
                            } else {
                                production_exit::finish_managed_game(
                                    &cleanup_host.state::<DesktopLog>(),
                                    |requires_proof| {
                                        cs2.finish_with_service_stopped(false)?;
                                        if requires_proof {
                                            cs2.confirm_game_stopped()?;
                                        }
                                        Ok(())
                                    },
                                )
                            }
                        },
                    );
                    let production = production_task
                        .join()
                        .unwrap_or_else(|_| Err("制作收尾结果未确认。".into()));
                    production_exit::cleanup_results(
                        production_exit::cleanup_results(exit_intent, production),
                        cleanup,
                    )?;
                    updates::recheck(&cleanup_host)
                })
                .await
                .unwrap_or_else(|_| Err("退出收尾未完成，请重试。".into()));
                if let Err(error) = result {
                    if !host.state::<production_exit::VerifiedStop>().complete() {
                        let intent_host = host.clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            production_exit::set_exit_intent(
                                &intent_host.state::<DesktopLog>(),
                                "cancel-exit",
                            )
                        })
                        .await;
                    }
                    updates::cancel(&host);
                    host.state::<DesktopLog>()
                        .event("cs2_exit_recovery", "failure", Some(&error));
                    host.state::<production_exit::ExitGate>().cancel();
                    let _ = workspace_presentation::hide_workspace(&host);
                    if host.state::<production_exit::VerifiedStop>().complete() {
                        // Direct service-stop callers may already have removed HTTP.
                        // Native recovery remains available through the tray, never a refused WebView.
                        for window in host.webview_windows().values() {
                            let _ = window.destroy();
                        }
                    } else {
                        let _ =
                            workspace_presentation::open_main(host.clone(), Some("/".into()), None);
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
            app.state::<updates::PendingUpdate>().invalidate();
            DesktopWorker {
                running: running.clone(),
                dispatch: dispatch.clone(),
                handle: worker.clone(),
            }
            .stop();
        }
        _ => (),
    });
    pending_update.invalidate();
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

fn start_gui(
    root: &Path,
    log: &DesktopLog,
    pending_update: &updates::PendingUpdate,
) -> Result<(), String> {
    let update_stage = pending_update.stage.clone();
    let scope = log.step("shutdown_scope", || shutdown_scope(root))?;
    let exit_signal = log.step("shutdown_signal", || ExitSignal::new(&scope))?;
    let _observer_job = log.step("observer_job", || observer_job::create(&log.session_id))?;
    let job = Arc::new(log.step("runtime_job", RuntimeJob::new)?);
    let mut child = log.step("runtime_spawn", || {
        supervisor(root, "--no-browser", Some(log), None)
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
        if let Err(error) = observer_hud::restore(log) {
            log.event("observer_hud_recovery", "failure", Some(&error));
        }
        let version = log.step("webview2_preflight", webview_preflight)?;
        log.event("webview2_version", "success", Some(&version));
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_desktop(
                log.clone(),
                exit_signal,
                job.clone(),
                pending_update.clone(),
            )
        })) {
            Ok(result) => result,
            Err(_) => Err("桌面界面启动或运行时发生异常；原始 panic 信息已记录。".into()),
        }
    })();
    let cleanup_stage = if outcome.is_err() {
        pending_update.cancel(log);
        "startup_rollback"
    } else {
        "shutdown"
    };
    log.event(cleanup_stage, "begin", None);
    // Failure cannot stop a same-artifact runtime borrowed from another session.
    // A successful desktop session's explicit exit may stop its verified local runtime.
    let mut stopped_target = None;
    let stop_result = if runtime_owned(log, child.id())
        || (outcome.is_ok() && host_runtime::health_matches(root))
    {
        match runtime_stop_target(root, false) {
            Ok(target) => {
                let result = log.step("runtime_stop", || {
                    stop_runtime(root, Some(log), &target.instance)
                });
                stopped_target = Some(target);
                result
            }
            Err(error) => Err(format!("runtime_stop_failed: {error}")),
        }
    } else {
        log.event(
            "runtime_stop",
            "skipped",
            Some("No runtime owned by this startup session."),
        );
        Ok(())
    };
    if let Err(error) = stop_result {
        pending_update.cancel(log);
        if error.starts_with("runtime_stop_timeout:") {
            // Explicit timeout is an abnormal recovery path, never a successful flush.
            let _ = job.terminate();
            let _ = wait_child(&mut child, Duration::from_secs(5));
        } else {
            // A rejected or uncertain stop must not kill a still-flushing runtime.
            job.kill_on_close(false).map_err(|e| e.to_string())?;
        }
        log.event(cleanup_stage, "failure", Some(&error));
        return Err(error);
    }
    // The matching Companion has exited. Its wrapper may take a moment to
    // finish recording its result; terminate only after an explicit timeout.
    if wait_child(&mut child, Duration::from_secs(5)).is_err() {
        let _ = job.terminate();
        let _ = child.wait();
        let error = "runtime_stop_timeout: 制播监督进程未退出";
        log.event(cleanup_stage, "failure", Some(error));
        return Err(error.into());
    }
    drop(job);
    if outcome.is_ok() {
        if let Some(target) = &stopped_target {
            if let Err(error) = write_host_stop_receipt(target) {
                log.event(cleanup_stage, "failure", Some(&error));
                return Err(format!("桌面退出未能记录完成：{error}"));
            }
        }
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
            eprintln!("observer_owner: {error}");
            1
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
    let root = match host_runtime::bundle_root() {
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
        let mut fallback_target = None;
        let host_stop = (|| -> Result<bool, String> {
            let scope = shutdown_scope(&root)?;
            if !ExitRequest::exists(&scope).map_err(|error| error.to_string())? {
                fallback_target = Some(runtime_stop_target(&root, false)?);
                return Ok(false);
            }
            // The scoped Host owns the game transaction. Repeated requests can
            // join an exit even after its HTTP listener has closed.
            let target = runtime_stop_target(&root, true)?;
            if !ExitRequest::notify(&scope).map_err(|error| error.to_string())? {
                fallback_target = Some(target);
                return Ok(false);
            }
            let deadline = Instant::now() + Duration::from_secs(310);
            while Instant::now() < deadline {
                // Both receipts name the original instance; a newer Host's
                // event lifetime cannot delay or satisfy this request.
                if runtime_stop_receipt(&target)? && host_stop_receipt(&target)? {
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
        let Some(target) = fallback_target else {
            eprintln!("无法确认要停止的运行实例。");
            std::process::exit(1);
        };
        if let Err(error) = stop_runtime(&root, None, &target.instance) {
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
        let outcome = supervisor(&root, "--no-browser", None, None).and_then(|mut child| {
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
    // This Host owns update staging until it exits; cancelled work cannot
    // publish an exit intent into the next Host.
    let pending_update = updates::PendingUpdate::new(Arc::new(Mutex::new(None)));
    if let Err(error) = start_gui(&root, &log, &pending_update) {
        pending_update.cancel(&log);
        log.event("startup_failed", "failure", Some(&error));
        let retry = if error.starts_with("webview2_preflight:") {
            windows_startup::recover_webview(&log, webview_preflight)
        } else {
            startup_recovery::show(&log, &error)
        };
        if retry {
            // A retry needs a new startup identity and desktop event loop.
            // Reusing this session reads its previous supervisor_error as a new failure.
            drop(_mutex);
            let restart = log.step("recovery_restart", || {
                Command::new(std::env::current_exe()?)
                    .args(args.iter().skip(1))
                    .current_dir(&root)
                    .creation_flags(0x08000000)
                    .spawn()
            });
            if let Err(error) = restart {
                failure_dialog(
                    &format!("无法重新启动 Mizar：{error}"),
                    Some(&log.directory),
                );
                std::process::exit(1);
            }
            return;
        }
        std::process::exit(1);
    }
}
