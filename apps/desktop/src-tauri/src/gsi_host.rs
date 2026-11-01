//! Host ownership of GSI script execution and preparation guards.
use crate::{
    cs2_diagnostics, powershell, preparation_gate, production_exit, startup_log::DesktopLog,
};
use std::{path::Path, sync::Mutex, time::Duration};
use tauri::Manager;

pub(crate) static GSI_OPERATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn gsi_script(
    name: &str,
    root: Option<&Path>,
    timeout: Duration,
    log: &DesktopLog,
) -> Result<String, String> {
    let bundle = crate::host_runtime::bundle_root()?;
    let mut command = powershell::background();
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
        command.arg("-Cs2Root").arg(powershell::provider_path(path));
    }
    let operation = match name {
        "gsi-status.ps1" => "CS2 与 GSI 检测",
        "install-gsi.ps1" => "安装 GSI",
        "restore-gsi.ps1" => "恢复 GSI",
        "select-cs2-installation.ps1" => "保存 CS2 安装位置",
        _ => "CS2 配置",
    };
    powershell::run(command, log, operation, timeout)
}

pub(crate) async fn status(log: DesktopLog) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GSI_OPERATION_LOCK
            .lock()
            .map_err(|_| "GSI 操作状态不可用。")?;
        let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
        let result = powershell::parse(&log, "GSI 检测", &output)?;
        Ok(cs2_diagnostics::gsi_status(&result))
    })
    .await
    .map_err(|_| "GSI 状态读取失败。".to_string())?
}

pub(crate) async fn ensure(
    app: tauri::AppHandle,
    log: DesktopLog,
    preparation_id: Option<String>,
    diagnostic_operation_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let diagnostic_log = log.clone();
    let command_log = log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let diagnostic_result = async {
        tauri::async_runtime::spawn_blocking({
            let command_log = command_log.clone();
            let native_operation_id = native_operation_id.clone();
            move || {
                let _guard = GSI_OPERATION_LOCK.lock().map_err(|error| {
                    command_log.preserve_error(
                        "ensure_gsi",
                        native_operation_id.as_deref(),
                        &error,
                        "GSI 操作状态不可用。",
                    )
                })?;
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
                if preparation_id.is_some() {
                    guard.commit(|| {
                        gsi_script("ensure-gsi.ps1", None, Duration::from_secs(45), &log)
                            .map(|_| ())
                    })?;
                } else {
                    gsi_script("ensure-gsi.ps1", None, Duration::from_secs(45), &log)?;
                }
                let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), &log)?;
                let result = powershell::parse(&log, "GSI 检测", &output)?;
                if preparation_id.is_some() {
                    guard.check()?;
                }
                Ok(cs2_diagnostics::gsi_status(&result))
            }
        })
        .await
        .map_err(|error| {
            command_log.preserve_error(
                "ensure_gsi",
                native_operation_id.as_deref(),
                &error,
                "GSI 自动配置未完成。".to_string(),
            )
        })?
    }
    .await;
    diagnostic_log.native_outcome(
        "ensure_gsi",
        diagnostic_operation_id.as_deref(),
        &diagnostic_result,
    );
    diagnostic_result
}
