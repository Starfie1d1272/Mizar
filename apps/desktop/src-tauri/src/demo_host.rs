//! Demo entry operations shared by the workspace entry owner.
use crate::{
    cs2_activity, demo_test, entry_intent::EntryIntent, host_state::HostState, managed_cs2,
    mulnx_launch, production_exit, startup_log::DesktopLog, updates, window_presentation,
    workspace_presentation,
};
use std::sync::Mutex;
use tauri::Manager;

pub(crate) async fn enter(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    intent_id: String,
    entry_ticket: u64,
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
        crate::window_presentation::check_demo_main(&window)?;
        let host = app.clone();
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            let native_task_id = native_task_id.clone();
            let native_trigger = native_trigger.clone();
            move || {
                host.state::<production_exit::ExitGate>()
                    .commit(entry_ticket, || {
                        host.state::<EntryIntent>().commit(&intent_id, false, || {
                            command_log.with_task(
                                native_task_id.as_deref(),
                                native_operation_id.as_deref(),
                                native_trigger.as_deref(),
                                || {
                                    let managed = host.state::<Mutex<managed_cs2::ManagedCs2>>();
                                    let log = host.state::<DesktopLog>();
                                    mulnx_launch::resume_demo(&host, &log, &request_id)?;
                                    let mut cs2 = managed.lock().map_err(|error| {
                                        command_log.preserve_error(
                                            "enter_demo_test",
                                            native_operation_id.as_deref(),
                                            &error,
                                            "CS2 配置状态不可用。",
                                        )
                                    })?;
                                    host.state::<production_exit::ExitGate>().check()?;
                                    host.state::<updates::PendingUpdate>().check()?;
                                    cs2.validate_demo_running(&request_id)?;
                                    let log = host.state::<DesktopLog>();
                                    let camera_trial = cs2
                                        .console_source()?
                                        .is_some_and(|(context, _)| context["mulnxLaunch"] == true);
                                    if camera_trial && cs2.managed_camera_lease().is_none() {
                                        if !mulnx_launch::observer_control_available(&cs2, &log) {
                                            return Err(
                                                "运镜工具尚未就绪，请检查试播游戏状态。".into()
                                            );
                                        }
                                        let game = cs2
                                            .workspace_process()?
                                            .filter(|game| game.is_running())
                                            .ok_or("试播游戏身份已变化。")?;
                                        let value = production_exit::camera_session(
                                            &log,
                                            "begin-demo",
                                            None,
                                            Some(&request_id),
                                        )?;
                                        let lease = value["lease"]
                                            .as_str()
                                            .ok_or("运镜会话未确认。")?
                                            .to_owned();
                                        if let Err(error) =
                                            cs2.bind_managed_camera(game, lease.clone())
                                        {
                                            let _ = production_exit::camera_session(
                                                &log,
                                                "invalidate",
                                                Some(&lease),
                                                None,
                                            );
                                            return Err(error);
                                        }
                                    }
                                    demo_test::request(&log, "playing", &request_id, None)?;
                                    drop(cs2);
                                    Ok(camera_trial)
                                },
                            )
                        })
                    })
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "enter_demo_test",
                native_operation_id.as_deref(),
                &error,
                "Demo 工作台未能打开。".to_string(),
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
                "enter_demo_test",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}

pub(crate) async fn start(
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
        window_presentation::check_demo_main(&window)?;
        app.state::<production_exit::ExitGate>().check()?;
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            move || {
                let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let mut cs2 = managed.lock().map_err(|error| {
                    command_log.preserve_error(
                        "start_demo_test",
                        native_operation_id.as_deref(),
                        &error,
                        "CS2 配置状态不可用。",
                    )
                })?;
                let activity = app.state::<cs2_activity::Activity>();
                let _activity = activity.begin(1);
                app.state::<production_exit::ExitGate>().check()?;
                app.state::<updates::PendingUpdate>().check()?;
                let path = app
                    .state::<Mutex<demo_test::Selection>>()
                    .lock()
                    .map_err(|error| {
                        command_log.preserve_error(
                            "start_demo_test",
                            native_operation_id.as_deref(),
                            &error,
                            "Demo 选择状态不可用。",
                        )
                    })?
                    .resolve(&token, &app.state::<DesktopLog>())?;
                cs2.ensure_demo_available()?;
                let log = app.state::<DesktopLog>();
                let launch_guard = if camera_trial.unwrap_or(false) {
                    let guard = mulnx_launch::demo_launch_guard()?;
                    if log
                        .state_root
                        .join("data/mulnx-launch/pending.json")
                        .exists()
                        || cs2.mulnx_launcher_running()?
                    {
                        return Err("请先完成上次 MulNX 启动的恢复。".into());
                    }
                    Some(guard)
                } else {
                    None
                };
                let id = demo_test::new_request_id(&log)?;
                let starting =
                    demo_test::request(&log, "begin", &id, Some((&team_a_name, &team_b_name)))?;
                if camera_trial.unwrap_or(false) {
                    drop(cs2);
                    let result = mulnx_launch::launch_demo(
                        &app,
                        &log,
                        &path,
                        &id,
                        preserve_settings.unwrap_or(false),
                        launch_guard.as_ref().unwrap(),
                    );
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
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "start_demo_test",
                native_operation_id.as_deref(),
                &error,
                "Demo 试播启动未完成。".to_string(),
            )
        })?
    }
    .await;
    diagnostic_log.native_outcome(
        "start_demo_test",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}
pub(crate) async fn resume(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
) -> Result<serde_json::Value, String> {
    window_presentation::check_demo_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let log = app.state::<DesktopLog>();
        mulnx_launch::resume_demo(&app, &log, &request_id)
    })
    .await
    .map_err(|_| "Demo 启动状态未能确认。".to_string())?
}
pub(crate) async fn finish(
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
                        host.state::<EntryIntent>().cancel_all();
                        let managed = host.state::<Mutex<managed_cs2::ManagedCs2>>();
                        let mut cs2 = managed.lock().map_err(|error| {
                            command_log.preserve_error(
                                "finish_demo_test",
                                native_operation_id.as_deref(),
                                &error,
                                "CS2 配置状态不可用。",
                            )
                        })?;
                        let activity = host.state::<cs2_activity::Activity>();
                        let _activity = activity.begin(2);
                        let state = match demo_test::status(&host.state::<DesktopLog>()) {
                            Ok(state) => state,
                            Err(_) if cs2.has_demo_journal()? => serde_json::Value::Null,
                            Err(error) => return Err(error),
                        };
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
                        let cleanup = cs2.finish();
                        workspace_presentation::refresh_finished_window_feedback(&host, &cs2);
                        let presentation = workspace_presentation::present_production_inner_checked(
                            &host, false, None, None,
                        );
                        production_exit::cleanup_results(cleanup, presentation)
                    },
                )
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "finish_demo_test",
                native_operation_id.as_deref(),
                &error,
                "Demo 试播恢复未完成。".to_string(),
            )
        })??;
        Ok(())
    }
    .await;
    diagnostic_log.with_task(
        diagnostic_task_id.as_deref(),
        diagnostic_operation_id.as_deref(),
        diagnostic_trigger.as_deref(),
        || {
            diagnostic_log.native_outcome(
                "finish_demo_test",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}
