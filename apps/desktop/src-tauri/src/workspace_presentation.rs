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
            let cs2 = managed
                .try_lock()
                .map_err(|_| "CS2 正忙，请稍后重试进入工作台。")?;
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
                    let show = |document: Option<u64>| {
                        host.state::<production_exit::WorkspaceExit>()
                            .complete(&Ok(()));
                        show_workspace(&host);
                        if let Some(request) = request {
                            let focus_host = host.clone();
                            let epoch = host
                                .state::<HostState>()
                                .workspace_epoch
                                .load(Ordering::Acquire);
                            let expected_page = expected_url.as_ref().map(|(url, _)| url.clone());
                            tauri::async_runtime::spawn_blocking(move || {
                                let same_document = document.is_some()
                                    && focus_host.state::<EntryIntent>().try_generation()
                                        == document;
                                let same_page = expected_page.as_ref().is_none_or(|expected| {
                                    focus_host.get_webview_window("main").is_some_and(|main| {
                                        main.url().ok().is_some_and(|url| url.as_str() == expected)
                                    })
                                });
                                let focused = same_document
                                    && same_page
                                    && attempt_game_focus(&focus_host, request);
                                focus_host.state::<DesktopLog>().event(
                                    "workspace_entry_focus",
                                    if focused { "focused" } else { "not_focused" },
                                    None,
                                );
                                let published_host = focus_host.clone();
                                if let Err(error) = focus_host.run_on_main_thread(move || {
                                    let gate = published_host.state::<production_exit::ExitGate>();
                                    let _ = gate.publish(ticket, || {
                                        let state = published_host.state::<HostState>();
                                        if state.visible.load(Ordering::Acquire)
                                            && state.workspace_epoch.load(Ordering::Acquire)
                                                == epoch
                                            && document.is_some()
                                            && published_host
                                                .state::<EntryIntent>()
                                                .try_generation()
                                                == document
                                        {
                                            if let Some(main) =
                                                published_host.get_webview_window("main")
                                            {
                                                if expected_page.as_ref().is_none_or(|expected| {
                                                    main.url()
                                                        .ok()
                                                        .is_some_and(|url| url.as_str() == expected)
                                                }) {
                                                    let _ = window_presentation::set_visible(
                                                        &main, false,
                                                    );
                                                }
                                            }
                                        }
                                    });
                                }) {
                                    focus_host.state::<DesktopLog>().event(
                                        "workspace_entry_focus",
                                        "failure",
                                        Some(&error.to_string()),
                                    );
                                }
                            });
                        } else if let Some(main) = host.get_webview_window("main") {
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
                            |document| show(Some(document)),
                        );
                    } else {
                        show(host.state::<EntryIntent>().try_generation());
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
            let Ok(tracker) = state.tracker.try_lock() else {
                return;
            };
            if let Some(game) = tracker.owned_window() {
                windows.push(game.hwnd);
            }
        }
    }
    let Ok(mut scope) = state.fullscreen_scope.try_lock() else {
        return;
    };
    let marked = scope.synchronize(&windows);
    drop(scope);
    if let Ok(mut tracker) = state.tracker.try_lock() {
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
        let Ok(tracker) = state.tracker.try_lock() else {
            return;
        };
        tracker.overlay_rect(&workspace_windows)
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
        let window = tracker.owned_window().ok_or("game_window_missing")?;
        if window.pid != process.pid {
            return Err("game_window_mismatch");
        }
        drop(tracker);
        let mut invoked = false;
        let focused = request.attempt(
            focus_session(&process),
            windows_host::foreground(),
            true,
            |source| {
                invoked = true;
                windows_host::restore_focus(window, &process, source)
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
    state.layout_request_generation.store(
        app.state::<production_exit::ExitGate>().generation(),
        Ordering::Release,
    );
    state.layout_dirty.store(true, Ordering::Release);
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
    if let Ok(mut group) = state.window_group.try_lock() {
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

pub(crate) fn refresh_finished_window_feedback(
    app: &tauri::AppHandle,
    cs2: &managed_cs2::ManagedCs2,
) {
    let log = app.state::<DesktopLog>();
    log.event("workspace_exit_feedback", "begin", None);
    // Optional feedback retirement cannot be used as proof of game/production cleanup.
    let result = app
        .state::<HostState>()
        .tracker
        .lock()
        .map_err(|_| "窗口反馈状态锁不可用。".to_owned())
        .and_then(|mut tracker| tracker.finish_session_feedback(cs2));
    match result {
        Ok(retired) => log.event("workspace_exit_feedback", if retired { "success" } else { "skipped" }, Some(&serde_json::json!({"retired":retired,"reason":if retired {"finished"} else {"no_feedback_or_no_stop_proof"}}).to_string())),
        Err(error) => log.event("workspace_exit_feedback", "failure", Some(&error)),
    }
}

pub(crate) fn present_review(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let monitor = app
        .get_webview_window("workspace-left")
        .and_then(|panel| panel.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法确定工作台所在屏幕。".to_string())?;
    let size = monitor.size();
    let origin = monitor.position();
    let scale = (size.width as f64 / 2560.0).min(size.height as f64 / 1440.0);
    let width = (1000.0 * scale).round() as u32;
    let height = (1160.0 * scale).round() as u32;
    window
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(
            origin.x + (size.width as i32 - outer.width as i32) / 2,
            origin.y + (size.height as i32 - outer.height as i32) / 2,
        ))
        .map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window_presentation::set_visible(window, true).map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

pub(crate) async fn open_tool(
    app: tauri::AppHandle,
    tool: String,
    preset_id: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
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
        if !matches!(kind, "preflight" | "roster" | "sync" | "issues" | "exit" | "connection" | "next-connection") { return Err("核对页面无法识别。".into()); }
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
        } else if tool == "review" && window.url().ok().as_ref() != Some(&target) {
            return Err("请先完成或关闭当前任务，再打开其他任务。".into());
        } else if tool != "review" {
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
    diagnostic_log.native_outcome(
        "open_tool",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn restore_layout(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<&'static str, serde_json::Value> {
    let state = app.state::<HostState>();
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: Result<&'static str, serde_json::Value> = (|| {
        if state.panels_only.load(Ordering::Acquire) {
            let main = app
                .get_webview_window("main")
                .ok_or_else(|| serde_json::json!("无法读取显示器工作区。"))?;
            let monitor = main
                .current_monitor()
                .ok()
                .flatten()
                .or_else(|| main.primary_monitor().ok().flatten())
                .ok_or_else(|| serde_json::json!("无法读取显示器工作区。"))?;
            let position = monitor.position();
            let size = monitor.size();
            apply_layout(
                &app,
                geometry::workspace_layout(Rect {
                    x: position.x,
                    y: position.y,
                    width: size.width as i32,
                    height: size.height as i32,
                }),
            );
            return Ok("panels");
        }
        if !state.visible.load(Ordering::Acquire) {
            return Err(serde_json::json!("请打开工作区后恢复布局。"));
        }
        app.state::<production_exit::ExitGate>()
            .check()
            .map_err(|error| serde_json::json!(error))?;
        state.layout_request_generation.store(
            app.state::<production_exit::ExitGate>().generation(),
            Ordering::Release,
        );
        state.layout_request.fetch_add(1, Ordering::AcqRel);
        state.layout_dirty.store(true, Ordering::Release);
        Ok("queued")
    })();
    diagnostic_log.native_outcome(
        "restore_layout",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

struct OverlayRecoveryGuard<'a> {
    state: &'a HostState,
    app: &'a tauri::AppHandle,
}
impl Drop for OverlayRecoveryGuard<'_> {
    fn drop(&mut self) {
        self.state
            .overlay_recovering
            .store(false, Ordering::Release);
        update_overlay(self.app, self.state);
    }
}

pub(crate) async fn recover_program_overlay(
    window: tauri::WebviewWindow,
    diagnostic_operation_id: Option<String>,
) -> Result<String, String> {
    if !matches!(window.label(), "workspace-left" | "workspace-dock") {
        return Err("请从现场工作台恢复本机 HUD。".into());
    }
    let app = window.app_handle().clone();
    let log = app.state::<DesktopLog>().inner().clone();
    log.event(
        "recover_program_overlay",
        "begin",
        Some(&serde_json::json!({"operationId":diagnostic_operation_id}).to_string()),
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HostState>();
        let _guard = overlay_recovery::try_lock(&state.live_window_lock)?;
        let caller = app
            .get_webview_window(window.label())
            .ok_or("工作台窗口已失效。")?;
        if !caller
            .hwnd()
            .ok()
            .zip(window.hwnd().ok())
            .is_some_and(|(a, b)| a == b)
        {
            return Err("工作台窗口已失效。".into());
        }
        let ticket = app
            .state::<production_exit::ExitGate>()
            .presentation_ticket()?;
        if !state.visible.load(Ordering::Acquire) {
            return Err("工作台已隐藏，请重新进入后再试。".into());
        }
        let workspace_epoch = state.workspace_epoch.load(Ordering::Acquire);
        let presentation = state
            .overlay_presentation
            .lock()
            .map_err(|_| "HUD 窗口状态不可用。")?;
        state.overlay_recovering.store(true, Ordering::Release);
        let epoch = state.overlay_epoch.fetch_add(1, Ordering::AcqRel) + 1;
        drop(presentation);
        let _recovery = OverlayRecoveryGuard {
            state: &state,
            app: &app,
        };
        let valid = || {
            overlay_recovery::workspace_valid(
                state.visible.load(Ordering::Acquire),
                workspace_epoch,
                state.workspace_epoch.load(Ordering::Acquire),
                app.state::<production_exit::ExitGate>()
                    .publish(ticket, || {})
                    .is_ok(),
            ) && state.overlay_epoch.load(Ordering::Acquire) == epoch
        };
        let old = app.get_webview_window("program-overlay");
        if let Some(old) = &old {
            let workspace_windows = overlay_workspace_windows(&app);
            let desired = state
                .tracker
                .lock()
                .ok()
                .and_then(|tracker| tracker.overlay_rect(&workspace_windows));
            observe_overlay(&app, old, desired, "before_recovery");
            if let Err(error) = window_presentation::snapshot_controller(old) {
                app.state::<DesktopLog>().event(
                    "program_overlay_snapshot",
                    "failure",
                    Some(&error),
                );
            }
        }
        overlay_recovery::replace(
            || {
                if !valid() {
                    return Err("恢复已取消。".into());
                }
                if let Some(old) = old {
                    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
                    old.on_window_event(move |event| {
                        if matches!(event, tauri::WindowEvent::Destroyed) {
                            let _ = sender.try_send(());
                        }
                    });
                    old.destroy()
                        .map_err(|error| format!("HUD 窗口销毁失败：{error}"))?;
                    receiver
                        .recv_timeout(Duration::from_secs(5))
                        .map_err(|_| "未确认旧 HUD 窗口销毁，请重试。")?;
                }
                Ok(())
            },
            || {
                let deadline = Instant::now() + Duration::from_secs(5);
                while app.get_webview_window("program-overlay").is_some() {
                    if !valid() {
                        return Err("恢复已取消。".into());
                    }
                    if Instant::now() >= deadline {
                        return Err("旧 HUD 窗口仍在释放，请重试。".into());
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(())
            },
            || {
                if !valid() {
                    return Err("恢复已取消。".into());
                }
                create_program_overlay(&app)
            },
        )?;
        let generation = state.overlay_generation.load(Ordering::Acquire);
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if !overlay_recovery::workspace_valid(
                state.visible.load(Ordering::Acquire),
                workspace_epoch,
                state.workspace_epoch.load(Ordering::Acquire),
                app.state::<production_exit::ExitGate>()
                    .publish(ticket, || {})
                    .is_ok(),
            ) || state.overlay_generation.load(Ordering::Acquire) != generation
            {
                if state.overlay_generation.load(Ordering::Acquire) == generation {
                    if let Some(current) = app.get_webview_window("program-overlay") {
                        let _ = current.destroy();
                    }
                }
                return Err("恢复已取消。".into());
            }
            if state.overlay_ready.load(Ordering::Acquire) == generation {
                return Ok("HUD 文档和策略已就绪；是否显示取决于当前游戏窗口条件。".into());
            }
            if Instant::now() >= deadline {
                if let Some(current) = app.get_webview_window("program-overlay") {
                    let _ = current.destroy();
                }
                return Err("HUD 文档或策略未能就绪，请检查运行诊断后重试。".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    log.native_outcome(
        "recover_program_overlay",
        diagnostic_operation_id.as_deref(),
        &result,
    );
    result
}

pub(crate) fn restore_cs2_focus(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> bool {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: bool = (|| {
        if !matches!(
            window.label(),
            "workspace-left" | "workspace-dock" | "tool-review"
        ) {
            return false;
        }
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let source = hwnd.0 as isize;
        if windows_host::foreground() != source {
            return false;
        }
        let request = {
            let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let Ok(cs2) = managed.try_lock() else {
                return false;
            };
            let Ok(Some(process)) = cs2.workspace_process() else {
                return false;
            };
            workspace_focus::Request::new(focus_session(&process), source)
        };
        request.is_some_and(|request| attempt_game_focus(&app, request))
    })();
    diagnostic_log.native_outcome(
        "restore_cs2_focus",
        diagnostic_operation_id.as_deref(),
        &Ok::<bool, String>(diagnostic_result),
    );
    diagnostic_result
}

pub(crate) fn set_overlay_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<HostState>();
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
        state
            .tracker
            .lock()
            .map_err(|error| {
                command_log.preserve_error(
                    "set_program_overlay_enabled",
                    native_operation_id.as_deref(),
                    &error,
                    "桌面窗口状态不可用。",
                )
            })?
            .overlay_enabled = enabled;
        update_overlay(&app, &state);
        Ok(())
    })();
    diagnostic_log.native_outcome(
        "set_program_overlay_enabled",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn overlay_ready(
    window: tauri::WebviewWindow,
    generation: u64,
    document_id: u64,
) -> Result<(), String> {
    if window.label() != "program-overlay" {
        return Err("窗口无权报告 HUD 状态。".into());
    }
    let app = window.app_handle();
    let state = app.state::<HostState>();
    {
        let _presentation = state
            .overlay_presentation
            .lock()
            .map_err(|_| "HUD 文档状态不可用。")?;
        let current = app
            .get_webview_window("program-overlay")
            .ok_or("HUD 窗口已失效。")?;
        if generation != state.overlay_generation.load(Ordering::Acquire)
            || !current
                .hwnd()
                .ok()
                .zip(window.hwnd().ok())
                .is_some_and(|(a, b)| a == b)
        {
            return Err("HUD 文档已失效。".into());
        }
        if document_id == 0 || document_id != state.overlay_document.load(Ordering::Acquire) {
            return Err("HUD 文档已失效。".into());
        }
        state.overlay_ready.store(generation, Ordering::Release);
    }
    app.state::<DesktopLog>().event(
        "program_overlay_document",
        "ready",
        Some(&serde_json::json!({"generation":generation,"documentId":document_id}).to_string()),
    );
    update_overlay(app, &state);
    Ok(())
}
