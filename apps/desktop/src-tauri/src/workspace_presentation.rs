//! Window presentation operations used by the host and IPC.
use crate::host_state::HostState;
use crate::{
    cs2_activity, demo_test,
    entry_intent::EntryIntent,
    geometry::{self, Layout, Rect},
    host_runtime::BASE,
    managed_cs2, overlay_recovery, preparation_gate, production_exit,
    startup_log::DesktopLog,
    updates, window_frame, window_presentation, windows_host, workspace_focus, workspace_group,
};
use std::{
    sync::{atomic::Ordering, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) async fn present(
    app: tauri::AppHandle,
    live: bool,
    preparation_id: Option<String>,
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
        tauri::async_runtime::spawn_blocking({
            let log = command_log.clone();
            let operation = native_operation_id.clone();
            move || {
                log.with_task(
                    native_task_id.as_deref(),
                    operation.as_deref(),
                    native_trigger.as_deref(),
                    || {
                        let ticket = match preparation_id.as_deref() {
                            Some(id) => {
                                app.state::<preparation_gate::PreparationGate>()
                                    .check(Some(id))?;
                                Some(preparation_gate::preparation_ticket(&app, id)?)
                            }
                            None => None,
                        };
                        match preparation_id.as_deref() {
                            Some(id) => app
                                .state::<preparation_gate::PreparationGate>()
                                .commit(Some(id), || {
                                    present_production_inner_checked(&app, live, None, ticket)
                                }),
                            None => present_production_inner_checked(&app, live, None, ticket),
                        }
                    },
                )
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "present_production",
                native_operation_id.as_deref(),
                &error,
                "现场窗口未能打开。".to_string(),
            )
        })?
    }
    .await;
    diagnostic_log.with_task(
        diagnostic_task_id.as_deref(),
        diagnostic_operation_id.as_deref(),
        diagnostic_trigger.as_deref(),
        || {
            diagnostic_log.native_outcome(
                "present_production",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}

pub(crate) async fn panels(app: tauri::AppHandle, preparation_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ticket = app
            .state::<production_exit::ExitGate>()
            .presentation_ticket()?;
        app.state::<preparation_gate::PreparationGate>()
            .check(Some(&preparation_id))?;
        {
            let state = app.state::<HostState>();
            let mut entry = state.entry_ticket.lock().map_err(|_| "启动状态不可用。")?;
            if let Some((saved, previous)) =
                entry.as_ref().filter(|(saved, _)| saved == &preparation_id)
            {
                app.state::<production_exit::ExitGate>()
                    .check_ticket(*previous)?;
                let _ = saved;
            } else {
                *entry = Some((preparation_id, ticket));
            }
        }
        ensure_live_windows(&app, false).map_err(|error| error.to_string())?;
        let main = app.get_webview_window("main").ok_or("准备中心不可用。")?;
        let monitor = main
            .current_monitor()
            .map_err(|e| e.to_string())?
            .or_else(|| main.primary_monitor().ok().flatten())
            .ok_or("无法确定工作台屏幕。")?;
        let pos = monitor.position();
        let size = monitor.size();
        let layout = geometry::workspace_layout(Rect {
            x: pos.x,
            y: pos.y,
            width: size.width as i32,
            height: size.height as i32,
        });
        let host = app.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = host
                .state::<production_exit::ExitGate>()
                .publish(ticket, || {
                    let state = host.state::<HostState>();
                    state.panels_only.store(true, Ordering::Release);
                    state.visible.store(true, Ordering::Release);
                    apply_layout(&host, layout);
                    for label in ["workspace-left", "workspace-dock"] {
                        if let Some(window) = host.get_webview_window(label) {
                            let _ = window_presentation::show_without_activation(&window);
                        }
                    }
                    let _ = window_presentation::set_visible(&main, false);
                });
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
        receiver
            .recv()
            .map_err(|_| "工作台面板未能打开。".to_string())?
    })
    .await
    .map_err(|_| "工作台面板未能打开。".to_string())?
}

pub(crate) fn open_main(
    app: tauri::AppHandle,
    path: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
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
            .navigate(format!("{BASE}{path}").parse().map_err(|error| {
                command_log.preserve_error(
                    "open_main",
                    native_operation_id.as_deref(),
                    &error,
                    "页面无法识别。",
                )
            })?)
            .map_err(|error| {
                command_log.preserve_error(
                    "open_main",
                    native_operation_id.as_deref(),
                    &error,
                    "无法打开 Mizar。",
                )
            })?;
        window.unminimize().map_err(|error| {
            command_log.preserve_error(
                "open_main",
                native_operation_id.as_deref(),
                &error,
                "准备中心窗口未能恢复，请重试。",
            )
        })?;
        window_presentation::set_visible(&window, true).map_err(|error| {
            command_log.preserve_error(
                "open_main",
                native_operation_id.as_deref(),
                &error,
                "准备中心窗口未能显示，请重试。",
            )
        })?;
        let _ = window.set_focus();
        Ok(())
    })();
    diagnostic_log.native_outcome(
        "open_main",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn present_production_inner_checked(
    app: &tauri::AppHandle,
    live: bool,
    expected_url: Option<(String, String)>,
    entry_ticket: Option<u64>,
) -> Result<(), String> {
    if live {
        let ticket = match entry_ticket {
            Some(ticket) => {
                app.state::<production_exit::ExitGate>()
                    .check_ticket(ticket)?;
                ticket
            }
            None => app
                .state::<production_exit::ExitGate>()
                .presentation_ticket()?,
        };
        // Capture before window creation/layout work. A later foreground change
        // cancels this one-shot intent; showing the panels must not select them.
        let source = app
            .get_webview_window("main")
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize)
            .filter(|hwnd| *hwnd == windows_host::foreground())
            .unwrap_or(0);
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let (mut request, process) = {
            let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let cs2 = managed.lock().map_err(|_| "CS2 配置状态不可用。")?;
            let process = cs2.workspace_process()?;
            let request = process.as_ref().and_then(|process| {
                app.state::<HostState>()
                    .entry_focus
                    .lock()
                    .ok()?
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
                    process
                        .as_ref()
                        .is_some_and(|process| window.pid == process.pid)
                });
                let decision = readiness.poll(
                    Instant::now(),
                    windows_host::foreground(),
                    eligible,
                    window_ready,
                );
                if decision == workspace_focus::ReadinessState::Waiting {
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                if decision != workspace_focus::ReadinessState::Ready {
                    request = None;
                }
                app.state::<DesktopLog>().event(
                    "workspace_entry_readiness",
                    match decision {
                        workspace_focus::ReadinessState::Ready => "ready",
                        workspace_focus::ReadinessState::TimedOut => "timed_out",
                        _ => "cancelled",
                    },
                    Some(&format!("elapsedMs={}", started.elapsed().as_millis())),
                );
                break;
            }
        }
        // A stop/exit can run while the render window is still loading.
        // Do not reopen a workspace whose managed game has been ended.
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        if app.state::<cs2_activity::Activity>().phase() != "idle"
            || process
                .as_ref()
                .is_some_and(|process| !process.is_running())
        {
            return Err("游戏启动已取消或正在恢复，请完成收尾后重新进入工作台。".into());
        }
        ensure_live_windows(&app, true).map_err(|error| {
            format!("现场窗口未能打开，准备中心仍可使用。请打开运行日志后重试。\n{error}")
        })?;
        let host = app.clone();
        let (published, completion) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            // Check and publish under the same gate on the actual UI thread.
            // An exit begun during readiness invalidates this callback even after it finishes.
            let mut valid_intent = true;
            let result = host
                .state::<production_exit::ExitGate>()
                .publish(ticket, || {
                    let show = || {
                        host.state::<production_exit::WorkspaceExit>()
                            .complete(&Ok(()));
                        show_workspace(&host);
                        if let Some(request) = request {
                            let focused = attempt_game_focus(&host, request);
                            host.state::<DesktopLog>().event(
                                "workspace_entry_focus",
                                if focused { "focused" } else { "not_focused" },
                                None,
                            );
                        }
                        if let Some(main) = host.get_webview_window("main") {
                            let _ = window_presentation::set_visible(&main, false);
                        }
                    };
                    if let Some((expected, id)) = &expected_url {
                        valid_intent = host.state::<EntryIntent>().publish(
                            id,
                            || {
                                host.get_webview_window("main").is_some_and(|window| {
                                    window.is_visible().ok() == Some(true)
                                        && window
                                            .url()
                                            .ok()
                                            .is_some_and(|url| url.as_str() == expected)
                                })
                            },
                            show,
                        );
                    } else {
                        show();
                    }
                });
            let result = result.and_then(|()| {
                if valid_intent {
                    Ok(())
                } else {
                    Err("进入页面已变化，请重新进入。".into())
                }
            });
            let _ = published.send(result);
        })
        .map_err(|error| error.to_string())?;
        completion
            .recv()
            .map_err(|_| "现场窗口呈现未能完成，请在准备中心重新进入工作台。".to_string())??;
    } else {
        open_main(app.clone(), None, None)?;
        hide_workspace(&app)?;
    }
    Ok(())
}

pub(crate) async fn present_demo(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    expected_url: String,
    intent_id: String,
    entry_ticket: Option<u64>,
) -> Result<(), String> {
    crate::window_presentation::check_demo_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = demo_test::status(&app.state::<DesktopLog>())?;
        if state["active"] != true
            || state["phase"] != "playing"
            || state["requestId"].as_str() != Some(&request_id)
        {
            return Err("试播状态已变化，请重新进入。".into());
        }
        app.state::<preparation_gate::PreparationGate>()
            .commit(Some(&intent_id), || {
                present_production_inner_checked(
                    &app,
                    true,
                    Some((expected_url, intent_id.clone())),
                    entry_ticket,
                )
            })
    })
    .await
    .map_err(|_| "试播工作台未能打开。".to_string())?
}

pub(crate) fn placement(window: &tauri::WebviewWindow, rect: Rect) {
    let _ = window_presentation::place(window, rect);
}

pub(crate) fn apply_layout(app: &tauri::AppHandle, layout: Layout) {
    if let Some(left) = app.get_webview_window("workspace-left") {
        placement(&left, layout.left);
    }
    if let Some(dock) = app.get_webview_window("workspace-dock") {
        placement(&dock, layout.dock);
    }
}

pub(crate) fn sync_workspace_shell(app: &tauri::AppHandle) {
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
        if !state.panels_only.load(Ordering::Acquire) {
            if let Ok(tracker) = state.tracker.lock() {
                if let Some(game) = tracker.owned_window() {
                    windows.push(game.hwnd);
                }
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

pub(crate) fn overlay_workspace_windows(app: &tauri::AppHandle) -> Vec<isize> {
    ["workspace-left", "workspace-dock"]
        .iter()
        .filter_map(|label| {
            app.get_webview_window(label)
                .and_then(|window| window.hwnd().ok())
                .map(|hwnd| hwnd.0 as isize)
        })
        .collect()
}

pub(crate) fn update_overlay(app: &tauri::AppHandle, state: &HostState) {
    let epoch = state.overlay_epoch.load(Ordering::Acquire);
    let workspace_windows = overlay_workspace_windows(app);
    let rect = if state.visible.load(Ordering::Acquire) {
        state
            .tracker
            .lock()
            .ok()
            .and_then(|tracker| tracker.overlay_rect(&workspace_windows))
    } else {
        None
    };
    present_overlay(app, rect, epoch);
}

pub(crate) fn observe_overlay(
    app: &tauri::AppHandle,
    overlay: &tauri::WebviewWindow,
    desired: Option<Rect>,
    phase: &str,
) {
    let state = app.state::<HostState>();
    let game = state
        .tracker
        .try_lock()
        .ok()
        .and_then(|tracker| tracker.window.map(|window| window.hwnd));
    let Ok(hwnd) = overlay.hwnd() else {
        return;
    };
    let mut detail =
        windows_host::overlay_diagnostic(hwnd.0 as isize, game, &overlay_workspace_windows(app));
    detail["generation"] = state.overlay_generation.load(Ordering::Acquire).into();
    detail["desiredRect"] = desired
        .map(|rect| [rect.x, rect.y, rect.width, rect.height])
        .into();
    detail["desiredVisible"] = desired.is_some().into();
    detail["documentReady"] = (state.overlay_ready.load(Ordering::Acquire)
        == state.overlay_generation.load(Ordering::Acquire))
    .into();
    let signature = detail.to_string();
    if let Ok(mut previous) = state.overlay_observation.lock() {
        if phase != "tick" || *previous != signature {
            app.state::<DesktopLog>()
                .event("program_overlay_snapshot", phase, Some(&signature));
            *previous = signature;
        }
    };
}

pub(crate) fn present_overlay(app: &tauri::AppHandle, rect: Option<Rect>, epoch: u64) {
    let ticket = app
        .state::<production_exit::ExitGate>()
        .presentation_ticket()
        .ok();
    let host = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = host.state::<HostState>();
        let Ok(_presentation) = state.overlay_presentation.lock() else {
            return;
        };
        if state.overlay_epoch.load(Ordering::Acquire) != epoch {
            return;
        }
        let Some(overlay) = host.get_webview_window("program-overlay") else {
            return;
        };
        let generation = state.overlay_generation.load(Ordering::Acquire);
        let game_allowed = state
            .tracker
            .try_lock()
            .is_ok_and(|tracker| tracker.overlay_still_allowed(&overlay_workspace_windows(&host)));
        let allowed = overlay_recovery::may_present(
            state.visible.load(Ordering::Acquire),
            state.overlay_recovering.load(Ordering::Acquire),
            generation,
            state.overlay_ready.load(Ordering::Acquire),
            game_allowed,
        );
        let desired = rect.filter(|_| allowed);
        let presented = ticket.is_some_and(|ticket| {
            host.state::<production_exit::ExitGate>()
                .publish(ticket, || {
                    if let Some(rect) = desired {
                        placement(&overlay, rect);
                        let _ = window_presentation::set_overlay_visible(&overlay, true);
                    } else {
                        let _ = window_presentation::set_overlay_visible(&overlay, false);
                    }
                })
                .is_ok()
        });
        if !presented {
            let _ = window_presentation::set_overlay_visible(&overlay, false);
        }
        observe_overlay(
            &host,
            &overlay,
            if presented { desired } else { None },
            "tick",
        );
    });
}

pub(crate) fn focus_session(process: &managed_cs2::WorkspaceProcess) -> workspace_focus::Session {
    workspace_focus::Session {
        pid: process.pid,
        created: process.created,
    }
}

pub(crate) fn attempt_game_focus(
    app: &tauri::AppHandle,
    request: workspace_focus::Request,
) -> bool {
    let result = (|| -> Result<(), &'static str> {
        let state = app.state::<HostState>();
        if !state.visible.load(Ordering::Acquire)
            || app.state::<production_exit::ExitGate>().check().is_err()
            || app.state::<cs2_activity::Activity>().phase() != "idle"
        {
            return Err("workspace_unavailable");
        }
        let cs2_state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let cs2 = cs2_state.try_lock().map_err(|_| "session_busy")?;
        let process = cs2
            .workspace_process()
            .map_err(|_| "session_invalid")?
            .ok_or("session_missing")?;
        if !process.is_running() {
            return Err("process_stopped");
        }
        let tracker = state.tracker.try_lock().map_err(|_| "tracker_busy")?;
        let window = tracker.window.ok_or("game_window_missing")?;
        if window.pid != process.pid {
            return Err("game_window_mismatch");
        }
        let mut invoked = false;
        let focused = request.attempt(
            focus_session(&process),
            windows_host::foreground(),
            true,
            |source| {
                invoked = true;
                tracker.restore_focus(source)
            },
        );
        if focused {
            Ok(())
        } else if invoked {
            Err("native_focus_not_acquired")
        } else {
            Err("intent_cancelled")
        }
    })();
    app.state::<DesktopLog>().event(
        "workspace_focus_attempt",
        if result.is_ok() {
            "focused"
        } else {
            "not_focused"
        },
        result.err(),
    );
    result.is_ok()
}

pub(crate) fn local_url(path: &str) -> WebviewUrl {
    WebviewUrl::External(format!("{BASE}{path}").parse().expect("fixed local URL"))
}

pub(crate) fn trusted_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(3000)
}

pub(crate) fn show_workspace(app: &tauri::AppHandle) {
    let state = app.state::<HostState>();
    state.panels_only.store(false, Ordering::Release);
    {
        let _presentation = state
            .overlay_presentation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.workspace_epoch.fetch_add(1, Ordering::AcqRel);
        state.overlay_epoch.fetch_add(1, Ordering::AcqRel);
        state.visible.store(true, Ordering::Release);
    }
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
    // The existing worker presents the HUD after the exit publication gate is released.
}

pub(crate) fn hide_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    {
        let _presentation = state
            .overlay_presentation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.workspace_epoch.fetch_add(1, Ordering::AcqRel);
        state.overlay_epoch.fetch_add(1, Ordering::AcqRel);
        state.visible.store(false, Ordering::Release);
    }
    if let Ok(mut group) = state.window_group.lock() {
        *group = workspace_group::Group::default();
    }
    sync_workspace_shell(app);
    let result = window_presentation::hide_panels(|label| {
        let Some(window) = app.get_webview_window(label) else {
            return Ok(());
        };
        window_presentation::hide_without_activation(&window).map_err(|error| {
            app.state::<DesktopLog>().event(
                "production_finish",
                "failure",
                Some(&format!(
                    "phase=workspace_hide_panel; label={label}; cause={error}"
                )),
            );
            let title = if label == "workspace-left" {
                "现场工作区"
            } else {
                "现场控制底栏"
            };
            format!("{title}未能隐藏，请在准备中心重试退出工作台。")
        })
    });
    if let Some(review) = app.get_webview_window("tool-review") {
        let _ = review.destroy();
    }
    present_overlay(app, None, state.overlay_epoch.load(Ordering::Acquire));
    result
}

pub(crate) fn main_path_allowed(path: &str) -> bool {
    [
        "/",
        "/matches",
        "/resources",
        "/matches?tab=roster",
        "/matches?tab=maps",
        "/matches#match-bp",
        "/matches#series-binding",
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

pub(crate) fn create_program_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    let generation = state.overlay_generation.fetch_add(1, Ordering::AcqRel) + 1;
    state.overlay_ready.store(0, Ordering::Release);
    state.overlay_epoch.fetch_add(1, Ordering::AcqRel);
    let script = format!("window.__MIZAR_OVERLAY_GENERATION__ = {generation};");
    let overlay = WebviewWindowBuilder::new(app, "program-overlay", local_url("/program?host=desktop"))
        .title("Mizar · Program HUD")
        .decorations(false).shadow(false).resizable(false).transparent(true)
        .always_on_top(true).focusable(false).focused(false).skip_taskbar(true).visible(false)
        .initialization_script(&script)
        .on_navigation(trusted_navigation)
        .on_page_load(move |window, payload| {
            let state = window.state::<HostState>();
            if state.overlay_generation.load(Ordering::Acquire) != generation { return; }
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let _presentation = state.overlay_presentation.lock().unwrap_or_else(|error| error.into_inner());
                if state.overlay_generation.load(Ordering::Acquire) != generation { return; }
                state.overlay_ready.store(0, Ordering::Release);
                state.overlay_epoch.fetch_add(1, Ordering::AcqRel);
                state.overlay_document.fetch_add(1, Ordering::AcqRel);
            } else if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let document_id = state.overlay_document.load(Ordering::Acquire);
                let script = format!("window.__MIZAR_OVERLAY_DOCUMENT__ = {document_id}; window.dispatchEvent(new Event('mizar-overlay-document'));");
                if let Err(error) = window.eval(&script) {
                    window.state::<DesktopLog>().event("program_overlay_document", "failure", Some(&error.to_string()));
                }
            }
            window.state::<DesktopLog>().event("program_overlay_navigation", "observed",
                Some(&serde_json::json!({"generation":generation,"documentId":state.overlay_document.load(Ordering::Acquire),"event":format!("{:?}", payload.event())}).to_string()));
        })
        .build().map_err(|error| error.to_string())?;
    if let Err(error) = window_presentation::observe_process_failure(&overlay, generation) {
        let _ = overlay.destroy();
        return Err(error);
    }
    if let Err(error) = overlay.set_ignore_cursor_events(true) {
        let _ = overlay.destroy();
        return Err(error.to_string());
    }
    if let Ok(hwnd) = overlay.hwnd() {
        window_frame::square_window(hwnd.0 as isize);
    }
    if let Err(error) = window_presentation::sync_visibility(&overlay) {
        let _ = overlay.destroy();
        return Err(error.to_string());
    }
    Ok(())
}

pub(crate) fn ensure_live_windows(app: &tauri::AppHandle, overlay: bool) -> Result<(), String> {
    let state = app.state::<HostState>();
    let _guard = state
        .live_window_lock
        .lock()
        .map_err(|_| "现场窗口状态不可用。")?;
    if ["workspace-left", "workspace-dock"]
        .iter()
        .all(|label| app.get_webview_window(label).is_some())
        && (!overlay || app.get_webview_window("program-overlay").is_some())
    {
        return Ok(());
    }
    let log = app.state::<DesktopLog>();
    let mut created = Vec::new();
    let result = (|| {
        if app.get_webview_window("workspace-left").is_none() {
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
            created.push("workspace-left");
        }
        if app.get_webview_window("workspace-dock").is_none() {
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
            created.push("workspace-dock");
        }
        if overlay && app.get_webview_window("program-overlay").is_none() {
            create_program_overlay(app)?;
            created.push("program-overlay");
        }
        for label in &created {
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
        for label in &created {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        log.event("live_windows_rollback", "success", None);
    }

    result
}
