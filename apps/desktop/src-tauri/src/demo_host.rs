//! Demo entry operations shared by the workspace entry owner.
use crate::{
    demo_test, entry_intent::EntryIntent, managed_cs2, mulnx_launch, production_exit,
    startup_log::DesktopLog, updates,
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
