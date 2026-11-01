//! Host-side managed game and camera operations shared by preparation and IPC.
use crate::host_state::HostState;
use crate::{
    cs2_activity, cs2_console, cs2_preferences, managed_cs2, mulnx_launch, observer_hud,
    preparation_gate, production_exit, startup_log::DesktopLog, updates, workspace_presentation,
};
use std::{fs, path::PathBuf, process::Command, sync::Mutex};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub(crate) async fn status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
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

pub(crate) async fn preflight(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
        cs2.preflight_replacement()
    })
    .await
    .map_err(|_| "无法检查游戏安装和实例。".to_string())?
}

pub(crate) async fn begin_camera(
    app: tauri::AppHandle,
    expected_revision: String,
    preparation_id: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut submitted = false;
        let outcome = (|| -> Result<(), String> {
            let ticket = preparation_gate::preparation_ticket(&app, &preparation_id)?;
            let _operation = crate::observer_workspace::operation()?;
            app.state::<production_exit::ExitGate>()
                .check_ticket(ticket)?;
            app.state::<preparation_gate::PreparationGate>()
                .check(Some(&preparation_id))?;
            app.state::<updates::PendingUpdate>().check()?;
            let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let mut cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
            let game = cs2
                .workspace_process()?
                .filter(|game| game.is_running())
                .ok_or("请先确认受管 CS2 已启动。")?;
            let actual = cs2.mulnx_handoff_status()?;
            let unique = actual["processes"].as_array().is_some_and(|processes| {
                processes.len() == 1
                    && processes[0]["pid"] == game.pid
                    && processes[0]["created"].as_str() == Some(game.created.to_string().as_str())
                    && processes[0]["managed"] == true
            });
            if !unique {
                return Err("受管游戏身份不唯一，未建立运镜会话。".into());
            }
            let log = app.state::<DesktopLog>();
            let gate = app.state::<preparation_gate::PreparationGate>();
            let exit = app.state::<production_exit::ExitGate>();
            gate.commit(Some(&preparation_id), || {
                exit.commit(ticket, || {
                    submitted = true;
                    let value = production_exit::camera_session(
                        &log,
                        "begin",
                        None,
                        Some(&expected_revision),
                    )?;
                    let lease = value["lease"]
                        .as_str()
                        .ok_or("原生运镜会话未确认。")?
                        .to_owned();
                    if let Err(error) = cs2.bind_managed_camera(game, lease.clone()) {
                        let _ =
                            production_exit::camera_session(&log, "invalidate", Some(&lease), None);
                        return Err(error);
                    }
                    Ok(())
                })
            })?;
            Ok(())
        })();
        Ok(match outcome {
            Ok(()) => serde_json::json!({"state":"ready"}),
            Err(error) if !submitted || error.starts_with("camera_not_started:") => {
                serde_json::json!({"state":"not_started", "message":error.strip_prefix("camera_not_started:").unwrap_or(&error)})
            }
            Err(error) => serde_json::json!({"state":"unknown", "message":error}),
        })
    })
    .await
    .map_err(|_| "受管运镜会话未能准备。".to_string())?
}

pub(crate) async fn cancel_camera(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
        if let Some((lease, _)) = cs2.managed_camera_lease() {
            cs2.invalidate_managed_camera();
            production_exit::camera_session(
                &app.state::<DesktopLog>(),
                "invalidate",
                Some(&lease),
                None,
            )?;
            cs2.clear_managed_camera();
        }
        Ok(())
    })
    .await
    .map_err(|_| "受管运镜会话未能取消。".to_string())?
}

pub(crate) async fn launch_mulnx(
    app: tauri::AppHandle,
    automatic: Option<bool>,
    preserve_settings: Option<bool>,
    resume_only: Option<bool>,
    preparation_id: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let log = app.state::<DesktopLog>().inner().clone();
    let evidence = log.clone();
    let operation_ticket = app
        .state::<production_exit::ExitGate>()
        .presentation_ticket()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation = crate::observer_workspace::operation()?;
        app.state::<production_exit::ExitGate>()
            .check_ticket(operation_ticket)?;
        preparation_gate::check_preparation(&app, preparation_id.as_deref())?;
        if let Some(id) = preparation_id.as_deref() {
            let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
            let status = cs2.status()?;
            if status["pending"] == true && status["preparationId"] != id {
                return Err("已有其他游戏事务，请先完成原配置恢复。".into());
            }
        }
        if resume_only.unwrap_or(false) {
            match preparation_id.as_deref() {
                Some(id) => {
                    let ticket = preparation_gate::preparation_ticket(&app, id)?;
                    app.state::<preparation_gate::PreparationGate>()
                        .commit(Some(id), || {
                            app.state::<production_exit::ExitGate>()
                                .commit(ticket, || mulnx_launch::resume(&app, &log))
                        })
                }
                None => mulnx_launch::resume(&app, &log),
            }
        } else {
            mulnx_launch::launch(
                &app,
                &log,
                automatic.unwrap_or(true),
                preserve_settings.unwrap_or(false),
                preparation_id.as_deref(),
            )
        }
    })
    .await
    .unwrap_or_else(|error| Err(format!("MulNX 启动任务失败：{error}")));
    evidence.native_outcome("launch_mulnx", diagnostic_operation_id.as_deref(), &result);
    result
}

pub(crate) async fn replace(
    app: tauri::AppHandle,
    expected_pid: Option<u32>,
    expected_created: Option<String>,
    expected_revision: String,
    preparation_id: String,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    let log = app.state::<DesktopLog>().inner().clone();
    let evidence = log.clone();
    let operation_ticket = app
        .state::<production_exit::ExitGate>()
        .presentation_ticket()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation = crate::observer_workspace::operation()?;
        app.state::<production_exit::ExitGate>()
            .check_ticket(operation_ticket)?;
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let created = expected_created
            .as_deref()
            .map(|v| {
                v.parse::<u64>()
                    .map_err(|_| "游戏创建标识无效。".to_string())
            })
            .transpose()?;
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = state.lock().map_err(|_| "CS2 状态不可用。")?;
        let gate = app.state::<preparation_gate::PreparationGate>();
        let exit_ticket = preparation_gate::preparation_ticket(&app, &preparation_id)?;
        let verify_exit = || {
            app.state::<production_exit::ExitGate>()
                .check_ticket(exit_ticket)
        };
        let guard = preparation_gate::PreparationGuard {
            gate: Some(gate.inner()),
            id: Some(&preparation_id),
            verify: Some(&verify_exit),
            exit: Some((
                app.state::<production_exit::ExitGate>().inner(),
                exit_ticket,
            )),
        };
        guard.check()?;
        let activity = app.state::<cs2_activity::Activity>();
        let _activity = activity.begin(3);
        let snapshot = cs2.preflight_replacement()?;
        if snapshot["target"]["managed"] == true
            && snapshot["preparationId"].as_str() == Some(preparation_id.as_str())
        {
            return cs2.replace_for_preparation(expected_pid, created, &preparation_id, &guard);
        }
        if let Some(pid) = snapshot["target"]["pid"].as_u64() {
            if Some(pid) != expected_pid.map(u64::from)
                || snapshot["target"]["created"].as_str() != expected_created.as_deref()
            {
                return Err("游戏实例已变化，未关闭游戏；请重新检查后重试。".into());
            }
        }
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        production_exit::prepare_external_entry(&log, &expected_revision)?;
        cs2.replace_for_preparation(expected_pid, created, &preparation_id, &guard)
    })
    .await
    .map_err(|_| "游戏替换未完成，请重试。".to_string())?;
    evidence.native_outcome(
        "replace_external_cs2",
        diagnostic_operation_id.as_deref(),
        &result,
    );
    result
}

pub(crate) async fn start(
    app: tauri::AppHandle,
    preserve_settings: Option<bool>,
    preparation_id: Option<String>,
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
        let operation_ticket = app
            .state::<production_exit::ExitGate>()
            .presentation_ticket()?;
        app.state::<production_exit::ExitGate>().check()?;
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            let native_task_id = native_task_id.clone();
            let native_trigger = native_trigger.clone();
            move || {
                command_log.with_task(
                    native_task_id.as_deref(),
                    native_operation_id.as_deref(),
                    native_trigger.as_deref(),
                    || {
                        let _operation = crate::observer_workspace::operation()?;
                        app.state::<production_exit::ExitGate>()
                            .check_ticket(operation_ticket)?;
                        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                        let mut cs2 = state.lock().map_err(|error| {
                            command_log.preserve_error(
                                "start_managed_cs2",
                                native_operation_id.as_deref(),
                                &error,
                                "CS2 配置状态不可用。",
                            )
                        })?;
                        let activity = app.state::<cs2_activity::Activity>();
                        let _activity = activity.begin(1);
                        app.state::<production_exit::ExitGate>().check()?;
                        app.state::<updates::PendingUpdate>().check()?;
                        production_exit::invalidate_local_match_exit(&app.state::<DesktopLog>())?;
                        let gate = app.state::<preparation_gate::PreparationGate>();
                        let exit_ticket = match preparation_id.as_deref() {
                            Some(id) => preparation_gate::preparation_ticket(&app, id)?,
                            None => app
                                .state::<production_exit::ExitGate>()
                                .presentation_ticket()?,
                        };
                        let verify_exit = || {
                            app.state::<production_exit::ExitGate>()
                                .check_ticket(exit_ticket)
                        };
                        let guard = preparation_gate::PreparationGuard {
                            gate: Some(gate.inner()),
                            id: preparation_id.as_deref(),
                            verify: preparation_id
                                .as_ref()
                                .map(|_| &verify_exit as &dyn Fn() -> Result<(), String>),
                            exit: preparation_id.as_ref().map(|_| {
                                (
                                    app.state::<production_exit::ExitGate>().inner(),
                                    exit_ticket,
                                )
                            }),
                        };
                        guard.check()?;
                        let result = cs2.start_preparation(
                            preserve_settings.unwrap_or(false),
                            preparation_id.as_deref(),
                            &guard,
                        );
                        if let Ok(mut tracker) = app.state::<HostState>().tracker.lock() {
                            tracker.preserve_settings = cs2.preserve_settings();
                        }
                        result
                    },
                )
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "start_managed_cs2",
                native_operation_id.as_deref(),
                &error,
                "CS2 启动未完成。".to_string(),
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
                "start_managed_cs2",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}

pub(crate) async fn finish_managed_cs2(
    app: tauri::AppHandle,
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
        let operation_ticket = app
            .state::<production_exit::ExitGate>()
            .presentation_ticket()?;
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            let native_task_id = native_task_id.clone();
            let native_trigger = native_trigger.clone();
            move || {
                command_log.with_task(
                    native_task_id.as_deref(),
                    native_operation_id.as_deref(),
                    native_trigger.as_deref(),
                    || {
                        let _operation = crate::observer_workspace::operation()?;
                        app.state::<production_exit::ExitGate>()
                            .check_ticket(operation_ticket)?;
                        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                        let mut cs2 = state.lock().map_err(|error| {
                            command_log.preserve_error(
                                "finish_managed_cs2",
                                native_operation_id.as_deref(),
                                &error,
                                "CS2 配置状态不可用。",
                            )
                        })?;
                        let activity = app.state::<cs2_activity::Activity>();
                        let _activity = activity.begin(2);
                        production_exit::finish_managed_game(
                            &app.state::<DesktopLog>(),
                            |requires_proof| {
                                cs2.finish()?;
                                if requires_proof {
                                    cs2.confirm_game_stopped()?;
                                }
                                Ok(())
                            },
                        )?;
                        workspace_presentation::refresh_finished_window_feedback(&app, &cs2);
                        Ok(())
                    },
                )
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "finish_managed_cs2",
                native_operation_id.as_deref(),
                &error,
                "CS2 原配置恢复未完成。".to_string(),
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
                "finish_managed_cs2",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}

pub(crate) async fn set_preferences(
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
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            move || {
                let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let mut cs2 = state.lock().map_err(|error| {
                    command_log.preserve_error(
                        "set_cs2_preferences",
                        native_operation_id.as_deref(),
                        &error,
                        "CS2 配置状态不可用。",
                    )
                })?;
                let activity = app.state::<cs2_activity::Activity>();
                let _activity = activity.begin(3);
                preferences.prefer_mulnx =
                    prefer_mulnx.unwrap_or(cs2.status()?["preferMulnx"].as_bool().unwrap_or(false));
                cs2.preferences(preferences)
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "set_cs2_preferences",
                native_operation_id.as_deref(),
                &error,
                "CS2 启动设置未保存。".to_string(),
            )
        })?
    }
    .await;
    diagnostic_log.native_outcome(
        "set_cs2_preferences",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) async fn restore_backup(
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
        let operation_ticket = app
            .state::<production_exit::ExitGate>()
            .presentation_ticket()?;
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            let native_task_id = native_task_id.clone();
            let native_trigger = native_trigger.clone();
            move || {
                command_log.with_task(
                    native_task_id.as_deref(),
                    native_operation_id.as_deref(),
                    native_trigger.as_deref(),
                    || {
                        let _operation = crate::observer_workspace::operation()?;
                        app.state::<production_exit::ExitGate>()
                            .check_ticket(operation_ticket)?;
                        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                        let mut cs2 = state.lock().map_err(|error| {
                            command_log.preserve_error(
                                "restore_cs2_backup",
                                native_operation_id.as_deref(),
                                &error,
                                "CS2 配置状态不可用。",
                            )
                        })?;
                        let activity = app.state::<cs2_activity::Activity>();
                        let _activity = activity.begin(2);
                        cs2.restore_backup(confirm_steam_cancelled)?;
                        workspace_presentation::refresh_finished_window_feedback(&app, &cs2);
                        Ok(())
                    },
                )
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "restore_cs2_backup",
                native_operation_id.as_deref(),
                &error,
                "CS2 原配置恢复未完成。".to_string(),
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
                "restore_cs2_backup",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}

pub(crate) async fn manage_backup(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    selection_id: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "main" {
        return Err("请在制作中心恢复游戏设置。".into());
    }
    let log = app.state::<DesktopLog>().inner().clone();
    let command_log = log.clone();
    let operation = diagnostic_operation_id.clone();
    let operation_ticket = app
        .state::<production_exit::ExitGate>()
        .presentation_ticket()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        app.state::<production_exit::ExitGate>().check()?;
        app.state::<updates::PendingUpdate>().check()?;
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        if action == "select" {
            // Retire prior approval before opening the modal native chooser.
            state
                .lock()
                .map_err(|_| "恢复状态不可用。")?
                .cancel_selected_backup();
            let Some(file) = app
                .dialog()
                .file()
                .add_filter("CS2 配置备份", &["txt", "bak"])
                .blocking_pick_file()
            else {
                return Ok(None);
            };
            let path = file.into_path().map_err(|e| {
                command_log.preserve_error(
                    "manage_cs2_backup",
                    operation.as_deref(),
                    &e,
                    "备份路径无法读取。",
                )
            })?;
            app.state::<production_exit::ExitGate>().check()?;
            app.state::<updates::PendingUpdate>().check()?;
            return state
                .lock()
                .map_err(|_| "恢复状态不可用。")?
                .select_backup(&path)
                .map(Some);
        }
        let _operation = crate::observer_workspace::operation()?;
        app.state::<production_exit::ExitGate>()
            .check_ticket(operation_ticket)?;
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
    })
    .await
    .map_err(|e| {
        log.preserve_error(
            "manage_cs2_backup",
            diagnostic_operation_id.as_deref(),
            &e,
            "备份操作未完成。",
        )
    })?;
    // The full selected file stays inside Host. Log the operation outcome rather
    // than duplicating avatar image bytes in the native diagnostic stream.
    log.native_outcome(
        "manage_cs2_backup",
        diagnostic_operation_id.as_deref(),
        &result.as_ref().map(|_| ()),
    );
    result
}

pub(crate) async fn open_backup(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = async move {
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            move || {
                let path = app
                    .state::<Mutex<managed_cs2::ManagedCs2>>()
                    .lock()
                    .map_err(|error| {
                        command_log.preserve_error(
                            "open_cs2_backup",
                            native_operation_id.as_deref(),
                            &error,
                            "CS2 配置状态不可用。",
                        )
                    })?
                    .backup_directory();
                fs::create_dir_all(&path).map_err(|error| {
                    command_log.preserve_error(
                        "open_cs2_backup",
                        native_operation_id.as_deref(),
                        &error,
                        "备份目录无法打开。",
                    )
                })?;
                let executable = PathBuf::from(
                    std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?,
                )
                .join("explorer.exe");
                Command::new(executable)
                    .arg(path)
                    .spawn()
                    .map_err(|error| {
                        command_log.preserve_error(
                            "open_cs2_backup",
                            native_operation_id.as_deref(),
                            &error,
                            "备份目录无法打开。",
                        )
                    })?;
                Ok(())
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "open_cs2_backup",
                native_operation_id.as_deref(),
                &error,
                "备份目录无法打开。".to_string(),
            )
        })?
    }
    .await;
    diagnostic_log.native_outcome(
        "open_cs2_backup",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) async fn console_settings(
    app: tauri::AppHandle,
    enabled: Option<bool>,
    expected_generation: Option<String>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<serde_json::Value, String> {
    let command = if enabled.is_some() {
        "set_cs2_console_capture"
    } else {
        "cs2_console_status"
    };
    let log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_log = log.clone();
    let join_operation = diagnostic_operation_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        log.with_task(
            diagnostic_task_id.as_deref(),
            diagnostic_operation_id.as_deref(),
            diagnostic_trigger.as_deref(),
            || {
                let result = (|| {
                    if let Some(enabled) = enabled {
                        cs2_console::set_enabled(&log, enabled, expected_generation.as_deref())?;
                    }
                    cs2_console::status(&log)
                })();
                log.native_outcome(command, diagnostic_operation_id.as_deref(), &result);
                result
            },
        )
    })
    .await
    .map_err(|error| {
        diagnostic_log.preserve_error(
            command,
            join_operation.as_deref(),
            &error,
            "技术日志设置未能完成，请重试。".to_string(),
        )
    })?
}

pub(crate) async fn mulnx_control(
    app: tauri::AppHandle,
    action: String,
    diagnostic_operation_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let log = app.state::<DesktopLog>().inner().clone();
    let evidence = log.clone();
    log.event("mulnx_control", "begin", Some(&format!("action={action}")));
    let operation_ticket = app
        .state::<production_exit::ExitGate>()
        .presentation_ticket()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation = crate::observer_workspace::operation()?;
        app.state::<production_exit::ExitGate>()
            .check_ticket(operation_ticket)?;
        match action.as_str() {
            "update" => mulnx_launch::update(&app, &log),
            _ => Err("请选择更新 MulNX。".into()),
        }
    })
    .await
    .unwrap_or_else(|error| Err(format!("MulNX 操作失败：{error}")));
    evidence.native_outcome("mulnx_control", diagnostic_operation_id.as_deref(), &result);
    result
}

pub(crate) async fn handoff_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<managed_cs2::ManagedCs2>>();
        let result = state
            .try_lock()
            .map_err(|_| "CS2 正忙，请稍后检查。".to_string())?
            .mulnx_handoff_status();
        result
    })
    .await
    .map_err(|_| "无法读取 CS2 进程身份。".to_string())?
}
