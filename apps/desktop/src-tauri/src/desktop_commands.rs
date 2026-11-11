//! Desktop command adapters; domain owners retain operation state and side effects.
use crate::{
    cs2_host, demo_host, desktop_types, gsi_host, obs_configuration, production_exit,
    support_export, updates, window_presentation, workspace_presentation,
};
use crate::{entry_intent::EntryIntent, host_state::HostState, startup_log::DesktopLog};
use crate::{powershell, preparation_task};
use std::sync::atomic::Ordering;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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

pub(crate) fn restore_layout(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<String, serde_json::Value> {
    workspace_presentation::restore_layout(app, diagnostic_operation_id).map(str::to_owned)
}

pub(crate) async fn restore_cs2_focus(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    let log = app.state::<DesktopLog>().inner().clone();
    let operation = diagnostic_operation_id.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || {
            workspace_presentation::restore_cs2_focus(window, app, diagnostic_operation_id)
        })
        .await
        {
            Ok(focused) => focused,
            Err(error) => {
                log.event(
                    "restore_cs2_focus",
                    "failure",
                    Some(&format!("operation={operation:?}; task={error}")),
                );
                false
            }
        },
    )
}

pub(crate) fn cs2_host_status(
    state: tauri::State<'_, HostState>,
) -> Result<desktop_types::Cs2HostStatus, String> {
    let tracker = state.tracker.try_lock().map_err(|error| match error {
        std::sync::TryLockError::WouldBlock => "游戏窗口操作正在进行，请稍后重试。",
        std::sync::TryLockError::Poisoned(_) => "桌面窗口状态不可用。",
    })?;
    Ok(desktop_types::Cs2HostStatus {
        found: tracker.window.is_some(),
        managed: tracker.layout_aligned,
        layout_aligned: tracker.layout_aligned,
        generation: tracker.generation,
        geometry: decode_result(tracker.geometry_diagnostics())?,
        message: tracker.window_message(),
        layout_pending: state.layout_request.load(Ordering::Acquire)
            != state.layout_completed.load(Ordering::Acquire),
        visible: state.visible.load(Ordering::Acquire),
    })
}

pub(crate) async fn select_obs_executable(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<Option<String>, String> {
    obs_configuration::select_executable(app, diagnostic_operation_id).await
}

pub(crate) async fn launch_obs(
    log: tauri::State<'_, DesktopLog>,
    executable_path: String,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    obs_configuration::launch_managed(
        executable_path,
        log.inner().clone(),
        diagnostic_operation_id,
    )
    .await
}

pub(crate) async fn begin_obs_configuration(
    log: tauri::State<'_, DesktopLog>,
    executable_path: String,
    session_id: String,
    document_generation: String,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    obs_configuration::begin_configuration(
        executable_path,
        session_id,
        document_generation,
        log.inner().clone(),
        diagnostic_operation_id,
    )
    .await
}

pub(crate) async fn finish_obs_configuration(
    log: tauri::State<'_, DesktopLog>,
    session_id: String,
    diagnostic_operation_id: Option<String>,
) -> Result<desktop_types::ObsConfigurationResult, String> {
    obs_configuration::finish_configuration(
        session_id,
        log.inner().clone(),
        diagnostic_operation_id,
    )
    .await
    .and_then(decode_result)
}

pub(crate) async fn read_obs_configuration_context(
    log: tauri::State<'_, DesktopLog>,
) -> Result<desktop_types::ObsConfigurationContext, String> {
    obs_configuration::read_configuration_context(log.inner().clone())
        .await
        .and_then(decode_result)
}

pub(crate) async fn mulnx_control(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: desktop_types::MulnxAction,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在准备中心管理 MulNX。".into());
    }
    cs2_host::mulnx_control(app, action.name().to_owned(), diagnostic_operation_id)
        .await
        .map(|_| ())
}

pub(crate) async fn workspace_exit_status(
    app: tauri::AppHandle,
) -> Result<desktop_types::WorkspaceExitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut status = app.state::<production_exit::WorkspaceExit>().status();
        status.window_message = app
            .state::<HostState>()
            .tracker
            .lock()
            .ok()
            .and_then(|tracker| tracker.window_message());
        status
    })
    .await
    .map_err(|error| format!("退出状态不可用：{error}"))
}

pub(crate) async fn finish_workspace(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    confirm_steam_cancelled: Option<bool>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<(), String> {
    production_exit::finish_workspace(
        window,
        app,
        confirm_steam_cancelled,
        diagnostic_operation_id,
        diagnostic_task_id,
        diagnostic_trigger,
        preparation_task::retire_after_exit,
    )
    .await
}

pub(crate) async fn select_demo_file(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<Option<desktop_types::SelectedDemo>, String> {
    demo_host::select_file(window, app, diagnostic_operation_id)
        .await
        .and_then(|value| value.map(decode_result).transpose())
}

pub(crate) async fn start_demo_test(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    token: String,
    team_a_name: String,
    team_b_name: String,
    preserve_settings: Option<bool>,
    camera_trial: Option<bool>,
    diagnostic_operation_id: Option<String>,
) -> Result<desktop_types::DemoTestView, String> {
    demo_host::start(
        window,
        app,
        token,
        team_a_name,
        team_b_name,
        preserve_settings,
        camera_trial,
        diagnostic_operation_id,
    )
    .await
    .and_then(decode_result)
}

pub(crate) async fn resume_demo_test(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
) -> Result<desktop_types::DemoTestView, String> {
    demo_host::resume(window, app, request_id)
        .await
        .and_then(decode_result)
}

pub(crate) fn entry_document(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<String, String> {
    window_presentation::check_demo_main(&window)?;
    app.state::<EntryIntent>().generation()
}

pub(crate) fn cancel_entry_intent(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    intent_id: String,
) -> Result<(), String> {
    window_presentation::check_demo_main(&window)?;
    if intent_id.len() != 36
        || !intent_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
    {
        return Err("进入请求无效。".into());
    }
    app.state::<EntryIntent>().cancel(&intent_id)
}

pub(crate) async fn finish_demo_test(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: Option<String>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<(), String> {
    demo_host::finish(
        window,
        app,
        request_id,
        diagnostic_operation_id,
        diagnostic_task_id,
        diagnostic_trigger,
    )
    .await
}

pub(crate) async fn cs2_console_status(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<desktop_types::ConsoleStatus, String> {
    cs2_host::console_settings(
        app,
        None,
        None,
        diagnostic_operation_id,
        diagnostic_task_id,
        diagnostic_trigger,
    )
    .await
    .and_then(decode_result)
}

pub(crate) async fn set_cs2_console_capture(
    app: tauri::AppHandle,
    enabled: bool,
    expected_generation: Option<String>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<desktop_types::ConsoleStatus, String> {
    cs2_host::console_settings(
        app,
        Some(enabled),
        expected_generation,
        diagnostic_operation_id,
        diagnostic_task_id,
        diagnostic_trigger,
    )
    .await
    .and_then(decode_result)
}

pub(crate) async fn set_cs2_preferences(
    app: tauri::AppHandle,
    quality_preset: desktop_types::QualityPreset,
    frame_rate_limit: desktop_types::FrameRateLimit,
    prefer_mulnx: Option<bool>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    cs2_host::set_preferences(
        app,
        quality_preset.name().to_owned(),
        frame_rate_limit.value(),
        prefer_mulnx,
        diagnostic_operation_id,
    )
    .await
}

pub(crate) async fn open_cs2_backup(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    cs2_host::open_backup(app, diagnostic_operation_id).await
}

pub(crate) fn open_main(
    app: tauri::AppHandle,
    path: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    workspace_presentation::open_main(app, path, diagnostic_operation_id)
}

pub(crate) async fn present_production(
    app: tauri::AppHandle,
    live: bool,
    preparation_id: Option<String>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<(), String> {
    workspace_presentation::present(
        app,
        live,
        preparation_id,
        diagnostic_operation_id,
        diagnostic_task_id,
        diagnostic_trigger,
    )
    .await
}

// Only the fixed Program surface is constructed here. Both paths use the same options.

pub(crate) fn program_overlay_ready(
    window: tauri::WebviewWindow,
    generation: u64,
    document_id: u64,
) -> Result<(), String> {
    workspace_presentation::overlay_ready(window, generation, document_id)
}

pub(crate) async fn recover_program_overlay(
    window: tauri::WebviewWindow,
    diagnostic_operation_id: Option<String>,
) -> Result<String, String> {
    workspace_presentation::recover_program_overlay(window, diagnostic_operation_id).await
}

// Review windows are centered on the workspace monitor, independently of the left panel.

pub(crate) fn close_review(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "tool-review" {
        return Err("只能关闭当前核对窗口。".into());
    }
    window.destroy().map_err(|e| e.to_string())
}

pub(crate) async fn open_tool(
    app: tauri::AppHandle,
    tool: String,
    preset_id: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    workspace_presentation::open_tool(app, tool, preset_id, diagnostic_operation_id).await
}

pub(crate) fn open_steam_api_key(
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
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
    })();
    diagnostic_log.native_outcome(
        "open_steam_api_key",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn open_issue_report(
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
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
    })();
    diagnostic_log.native_outcome(
        "open_issue_report",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) async fn install_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: Result<(), String> = async move {
        if window.label() != "main" {
            return Err("请在制作中心的高级设置中确认升级。".into());
        }
        updates::prepare(app).await
    }
    .await;
    diagnostic_log.native_outcome(
        "install_update",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn open_music_downloads(
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = "https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/?p=/Music\0"
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
    let outcome = if result <= 32 {
        Err(log.preserve_error(
            "open_music_downloads",
            diagnostic_operation_id.as_deref(),
            &result,
            "音乐包下载页面未能打开，请重试。".into(),
        ))
    } else {
        Ok(())
    };
    log.native_outcome(
        "open_music_downloads",
        diagnostic_operation_id.as_deref(),
        &outcome,
    );
    outcome
}

pub(crate) fn open_update_page(
    log: tauri::State<'_, DesktopLog>,
    source: String,
    version: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
        // Retain the old source value for an already-loaded WebView. New assets live on GitHub.
        let url = if source == "github" || source == "mirror" {
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
    })();
    diagnostic_log.native_outcome(
        "open_update_page",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn open_update_recovery(
    app: tauri::AppHandle,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let diagnostic_result: Result<(), String> = (|| {
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
    })();
    diagnostic_log.native_outcome(
        "open_update_recovery",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn open_rivalhub_authorization(
    log: tauri::State<'_, DesktopLog>,
    url: String,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
        let parsed = tauri::Url::parse(&url).map_err(|error| {
            command_log.preserve_error(
                "open_rivalhub_authorization",
                native_operation_id.as_deref(),
                &error,
                "授权页面地址无效。",
            )
        })?;
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
    })();
    diagnostic_log.native_outcome(
        "open_rivalhub_authorization",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) fn valid_workbench_path(path: &str) -> bool {
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

pub(crate) fn open_rivalhub_workbench(
    log: tauri::State<'_, DesktopLog>,
    url: String,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    let diagnostic_log = log.inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result: Result<(), String> = (|| {
        let parsed = tauri::Url::parse(&url).map_err(|error| {
            command_log.preserve_error(
                "open_rivalhub_workbench",
                native_operation_id.as_deref(),
                &error,
                "比赛工作台地址无效。",
            )
        })?;
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
    })();
    diagnostic_log.native_outcome(
        "open_rivalhub_workbench",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}

pub(crate) async fn gsi_status(
    log: tauri::State<'_, DesktopLog>,
) -> Result<desktop_types::GsiStatus, String> {
    gsi_host::status(log.inner().clone())
        .await
        .and_then(decode_result)
}

pub(crate) async fn control_cs2_frame_rate(
    app: tauri::AppHandle,
    action: desktop_types::FrameRateAction,
    frame_rate_limit: Option<desktop_types::FrameRateLimit>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
) -> Result<desktop_types::FrameRateReading, String> {
    cs2_host::control_frame_rate(
        app,
        action.name().to_owned(),
        frame_rate_limit.map(desktop_types::FrameRateLimit::value),
        diagnostic_operation_id,
        diagnostic_task_id,
        diagnostic_trigger,
    )
    .await
    .and_then(decode_result)
}

pub(crate) async fn persist_diagnostic_events(
    log: tauri::State<'_, DesktopLog>,
    events: Vec<serde_json::Value>,
) -> Result<desktop_types::DiagnosticReceipt, String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || log.persist_document_events(&events))
        .await
        .map_err(|error| format!("诊断持久写入任务未完成：{error}"))?
        .and_then(decode_result)
}

pub(crate) async fn diagnostic_pin(
    log: tauri::State<'_, DesktopLog>,
    action: desktop_types::PinAction,
    pin_id: String,
    kind: desktop_types::PinKind,
) -> Result<desktop_types::DiagnosticPin, String> {
    let log = log.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        log.diagnostic_pin(action.name(), &pin_id, kind.name())
    })
    .await
    .map_err(|error| format!("诊断固定任务未完成：{error}"))?
    .and_then(decode_result)
}

pub(crate) async fn save_support_bundle(
    app: tauri::AppHandle,
    export_id: String,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    diagnostic_log.event(
        "support_save",
        "begin",
        Some(
            &serde_json::json!({
                "exportId": export_id,
                "operationId": diagnostic_operation_id,
            })
            .to_string(),
        ),
    );
    let state_root = app.state::<DesktopLog>().state_root.clone();
    let save_log = diagnostic_log.clone();
    let operation_id = diagnostic_operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let prepared = support_export::prepare_generated(&state_root, &export_id)?;
        let dialog_started = std::time::Instant::now();
        let destination = match prepared.suggested_filename() {
            Some(name) => app
                .dialog()
                .file()
                .set_title("保存 Mizar 诊断包")
                .set_file_name(name)
                .add_filter("ZIP 诊断包", &["zip"])
                .blocking_save_file(),
            None => app
                .dialog()
                .file()
                .set_title("选择 Mizar 诊断分卷保存目录")
                .blocking_pick_folder(),
        };
        save_log.event(
            "support_save",
            "dialog",
            Some(
                &serde_json::json!({
                    "exportId": export_id,
                    "operationId": operation_id,
                    "dialogMs": dialog_started.elapsed().as_millis(),
                    "cancelled": destination.is_none(),
                })
                .to_string(),
            ),
        );
        let Some(destination) = destination else {
            return Ok(false);
        };
        let path = destination
            .into_path()
            .map_err(|_| "保存位置无效，请重新选择。")?;
        let copy_started = std::time::Instant::now();
        let saved = prepared.save(&path);
        save_log.event(
            "support_save",
            "copy",
            Some(
                &serde_json::json!({
                    "exportId": export_id,
                    "operationId": operation_id,
                    "copyMs": copy_started.elapsed().as_millis(),
                    "success": saved.is_ok(),
                })
                .to_string(),
            ),
        );
        saved?;
        Ok(true)
    })
    .await
    .map_err(|_| "保存窗口未能打开，请重试。".to_string())
    .and_then(|result| result);
    if matches!(result, Ok(false)) {
        diagnostic_log.event(
            "support_save",
            "cancelled",
            Some(
                &serde_json::json!({
                    "operationId": diagnostic_operation_id,
                })
                .to_string(),
            ),
        );
    } else {
        diagnostic_log.native_outcome(
            "save_support_bundle",
            diagnostic_operation_id.as_deref(),
            &result,
        );
    }
    result
}

pub(crate) async fn select_cs2_installation(
    app: tauri::AppHandle,
    executable: bool,
    diagnostic_operation_id: Option<String>,
) -> Result<bool, String> {
    gsi_host::select_installation(app, executable, diagnostic_operation_id).await
}

pub(crate) async fn open_cs2_config_directory(
    log: tauri::State<'_, DesktopLog>,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    gsi_host::open_config_directory(log.inner().clone(), diagnostic_operation_id).await
}

pub(crate) async fn configure_gsi(
    app: tauri::AppHandle,
    restore: bool,
    choose: bool,
    diagnostic_operation_id: Option<String>,
) -> Result<(), String> {
    gsi_host::configure(app, restore, choose, diagnostic_operation_id).await
}

pub(crate) async fn observer_command(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: desktop_types::ObserverAction,
    endpoint: Option<String>,
    password: Option<String>,
    expected_revision: Option<String>,
) -> Result<desktop_types::ObserverResult, String> {
    crate::observer_workspace::observer_command(
        window,
        app,
        action.name().to_owned(),
        endpoint,
        password,
        expected_revision,
    )
    .await
    .and_then(decode_result)
}

fn decode_result<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "桌面操作结果格式无效，请核对当前状态。".into())
}
