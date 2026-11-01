//! Window presentation operations used by the host and IPC.
use crate::{
    apply_layout, attempt_game_focus, cs2_activity, demo_main_window, demo_test,
    ensure_live_windows,
    entry_intent::EntryIntent,
    focus_session,
    geometry::{self, Rect},
    hide_workspace, main_path_allowed, managed_cs2, preparation_gate, preparation_ticket,
    production_exit, show_workspace,
    startup_log::DesktopLog,
    updates, window_presentation, windows_host, workspace_focus, HostState, BASE,
};
use std::{
    sync::{atomic::Ordering, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

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
                                Some(preparation_ticket(&app, id)?)
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
    demo_main_window(&window)?;
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
