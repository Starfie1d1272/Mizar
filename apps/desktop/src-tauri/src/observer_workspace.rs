//! Workbench intents use the verified game handle and the current desktop Job.
use crate::{managed_cs2, observer_job, production_exit, startup_log::DesktopLog};
use std::{sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::{Instant, Duration}};
use tauri::Manager;
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn request(log: &DesktopLog, body: serde_json::Value) -> Result<(), String> {
    let token = production_exit::runtime_token(log)?;
    let timeout = if body["action"] == "pulse" { 1 } else { 18 };
    let (code, value) = production_exit::request_with_identity(log, "POST", "/operator/runtime/observer",
        &body.to_string(), Instant::now() + Duration::from_secs(timeout), Some(&token))?;
    if code != 200 || value["ok"] != true {
        return Err(value["message"].as_str().unwrap_or("请检查本地服务后重试观察辅助连接。").into());
    }
    Ok(())
}

pub fn stop(log: &DesktopLog) -> Result<(), String> {
    if ACTIVE.load(Ordering::Acquire) {
        request(log, serde_json::json!({"action":"stop"}))?;
        ACTIVE.store(false, Ordering::Release);
    }
    Ok(())
}

pub fn pulse(app: &tauri::AppHandle, cs2: &managed_cs2::ManagedCs2) {
    if !ACTIVE.load(Ordering::Acquire) { return; }
    let log = app.state::<DesktopLog>();
    let valid = cs2.workspace_process().ok().flatten().is_some_and(|game| game.is_running());
    let result = if valid { request(&log, serde_json::json!({"action":"pulse"})) } else { stop(&log) };
    if let Err(error) = result { log.event("observer_lease", "failure", Some(&error)); }
}

#[tauri::command]
pub async fn observer_command(window: tauri::WebviewWindow, app: tauri::AppHandle,
    action: String, endpoint: Option<String>, password: Option<String>) -> Result<(), String> {
    if !["workspace-left", "workspace-dock"].contains(&window.label()) {
        return Err("请在制播工作台操作观察辅助。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let log = app.state::<DesktopLog>();
        log.event("observer_workspace", "begin", Some(&format!("action={action}")));
        let result = (|| {
            if action == "stop" {
                request(&log, serde_json::json!({"action":"stop"}))?;
                ACTIVE.store(false, Ordering::Release);
                return Ok(());
            }
            if action != "start" { return Err("请选择连接或停止观察辅助。".into()); }
            app.state::<production_exit::ExitGate>().check()?;
            app.state::<crate::updates::PendingUpdate>().check()?;
            if !app.state::<crate::HostState>().visible.load(Ordering::Acquire) {
                return Err("请打开制播工作台后连接早源。".into());
            }
            let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let cs2 = managed.lock().map_err(|_| "请等待游戏操作完成后重试。")?;
            let (context, game) = cs2.console_source()?.ok_or("请先从工作台启动或接入 CS2。")?;
            if !game.is_running() { return Err("请先启动 CS2，再连接观察辅助。".into()); }
            let executable = context["executable"].as_str().ok_or("请确认 CS2 安装位置。")?;
            request(&log, serde_json::json!({"action":"start", "executable":executable,
                "job":observer_job::name(&log.session_id),
                "endpoint":endpoint.ok_or("请填写授权的 GOTV 地址。")?, "password":password.unwrap_or_default()}))?;
            ACTIVE.store(true, Ordering::Release);
            Ok(())
        })();
        log.event("observer_workspace", if result.is_ok() { "success" } else { "failure" }, result.as_ref().err().map(String::as_str));
        result
    }).await.map_err(|error| format!("观察辅助操作需要重试：{error}"))?
}
