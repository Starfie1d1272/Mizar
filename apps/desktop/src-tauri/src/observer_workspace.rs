//! Workbench intents use the verified game handle and the current desktop Job.
use crate::{managed_cs2, observer_job, production_exit, startup_log::DesktopLog};
use std::{sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::{Instant, Duration}};
use tauri::Manager;
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn request(log: &DesktopLog, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = production_exit::runtime_token(log)?;
    let timeout = if body["action"] == "pulse" { 1 } else { 18 };
    let (code, value) = production_exit::request_with_identity(log, "POST", "/operator/runtime/observer",
        &body.to_string(), Instant::now() + Duration::from_secs(timeout), Some(&token))?;
    if code != 200 || value["ok"] != true {
        return Err(value["message"].as_str().unwrap_or("请检查本地服务后重试观察辅助连接。").into());
    }
    Ok(value)
}

pub fn active() -> bool { ACTIVE.load(Ordering::Acquire) }


pub fn stop(log: &DesktopLog) -> Result<(), String> {
    if ACTIVE.load(Ordering::Acquire) {
        request(log, serde_json::json!({"action":"stop"}))?;
        ACTIVE.store(false, Ordering::Release);
    }
    Ok(())
}

/// End game automation only at the production/control boundary, independently of auxiliary enablement.
pub fn finish(log: &DesktopLog) -> Result<(), String> {
    let observer = stop(log);
    let hud = crate::observer_hud::restore(log);
    production_exit::cleanup_results(observer, hud)
}

pub fn pulse(app: &tauri::AppHandle, cs2: &managed_cs2::ManagedCs2) {
    if !ACTIVE.load(Ordering::Acquire) { return; }
    let log = app.state::<DesktopLog>();
    let valid = cs2.workspace_process().ok().flatten().is_some_and(|game| game.is_running());
    let result = if valid {
        request(&log, serde_json::json!({"action":"pulse"})).and_then(|value| {
            if value["enabled"] == false { stop(&log) } else { Ok(()) }
        })
    } else { stop(&log) };
    if let Err(error) = result { log.event("observer_lease", "failure", Some(&error)); }
}

#[tauri::command]
pub async fn observer_command(window: tauri::WebviewWindow, app: tauri::AppHandle,
    action: String, endpoint: Option<String>, password: Option<String>, expected_revision: Option<String>) -> Result<serde_json::Value, String> {
    if !["main", "workspace-left", "workspace-dock"].contains(&window.label())
        && !(window.label() == "tool-review" && matches!(action.as_str(), "start-configured" | "connection-mode")
            && window.url().ok().is_some_and(|url| url.path() == "/workspace/review" && matches!(url.query(), Some("kind=connection" | "kind=next-connection")))) {
        return Err("请在制播工作台操作观察辅助。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let log = app.state::<DesktopLog>();
        log.event("observer_workspace", "begin", Some(&format!("action={action}")));
        let mut automation = None;
        let result: Result<(), String> = (|| {
            if action == "connection-mode" {
                let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let cs2 = managed.try_lock().map_err(|_| "请等待游戏操作完成后重试。")?;
                automation = Some(crate::mulnx_launch::observer_control_available(&cs2, &log));
                return Ok(());
            }
            if action == "stop" {
                request(&log, serde_json::json!({"action":"stop"}))?;
                ACTIVE.store(false, Ordering::Release);
                return Ok(());
            }
            if action == "restore-hud" {
                app.state::<production_exit::ExitGate>().check()?;
                app.state::<crate::updates::PendingUpdate>().check()?;
                let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let _cs2 = managed.lock().map_err(|_| "请等待游戏操作完成后重试。")?;
                return crate::observer_hud::restore(&log);
            }
            if action == "preflight" {
                let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let cs2 = managed.lock().map_err(|_| "请等待游戏操作完成后重试。")?;
                let native = cs2.console_source()?.is_some_and(|(context, _)| context["nativeHudToggle"] == true && context["spectatorCfg"] == true);
                if !native { crate::observer_hud::preflight(&log, cs2.status()?["preferMulnx"] == true)?; }
                return Ok(());
            }
            if action != "start" && action != "start-configured" { return Err("请选择连接或停止观察辅助。".into()); }
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
            if action == "start-configured" {
                let job = observer_job::name(&log.session_id);
                let use_mulnx = crate::mulnx_launch::observer_control_available(&cs2, &log);
                automation = Some(use_mulnx);
                let game_key = format!("{}-{}", game.pid, game.created);
                let native_hud_toggle = context["nativeHudToggle"] == true && context["spectatorCfg"] == true;
                let mut intent = serde_json::json!({"action":"prepare","game":game_key,"job":job,"useMulnx":use_mulnx,"nativeHudToggle":native_hud_toggle});
                if let Some(revision) = expected_revision { intent["expectedRevision"] = revision.into(); }
                let preparation = request(&log, intent)?;
                if native_hud_toggle && use_mulnx && crate::observer_hud::preflight(&log, true)? {
                    crate::observer_hud::initialize(&log, std::path::Path::new(executable), &game)?;
                }
                if preparation["enabled"] != true { stop(&log)?; return Ok(()); }
                if preparation["reuse"] == true { ACTIVE.store(true, Ordering::Release); return Ok(()); }
                let mut body = serde_json::json!({"action":"start-configured","executable":executable,
                    "game":game_key,"job":job,"revision":preparation["revision"],"useMulnx":use_mulnx,"nativeHudToggle":native_hud_toggle});
                if preparation["hideGameHud"] == true {
                    body["hudOriginal"] = crate::observer_hud::snapshot(&log, std::path::Path::new(executable), &game)?.into();
                } else if !native_hud_toggle { crate::observer_hud::restore(&log)?; }
                ACTIVE.store(true, Ordering::Release);
                // Keep the accepted program operation and HUD journal on auxiliary failure.
                // Exit restores the original value; retry reuses the same game transaction.
                request(&log, body)?;
                return Ok(());
            }
            request(&log, serde_json::json!({"action":"start", "executable":executable,
                "job":observer_job::name(&log.session_id),
                "endpoint":endpoint.ok_or("请填写授权的 GOTV 地址。")?, "password":password.unwrap_or_default()}))?;
            ACTIVE.store(true, Ordering::Release);
            Ok(())
        })();
        log.event("observer_workspace", if result.is_ok() { "success" } else { "failure" }, result.as_ref().err().map(String::as_str));
        result.map(|()| serde_json::json!({"useMulnx":automation}))
    }).await.map_err(|error| format!("观察辅助操作需要重试：{error}"))?
}
