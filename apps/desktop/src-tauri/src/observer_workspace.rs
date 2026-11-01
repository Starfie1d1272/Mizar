//! Workbench intents use the verified game handle and the current desktop Job.
use crate::{managed_cs2, observer_job, production_exit, startup_log::DesktopLog};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static OPERATION: Mutex<()> = Mutex::new(());

// Session mutations and observer operations always acquire this before ManagedCs2.
pub(crate) fn operation() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    OPERATION
        .lock()
        .map_err(|_| "游戏与观察辅助操作状态不可用。".into())
}
pub(crate) fn cleanup_operation() -> std::sync::MutexGuard<'static, ()> {
    OPERATION.lock().unwrap_or_else(|error| error.into_inner())
}
pub(crate) fn try_operation() -> Option<std::sync::MutexGuard<'static, ()>> {
    OPERATION.try_lock().ok()
}

fn request(log: &DesktopLog, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = production_exit::runtime_token(log)?;
    let timeout = if body["action"] == "pulse" { 1 } else { 18 };
    let (code, value) = production_exit::request_with_identity(
        log,
        "POST",
        "/operator/runtime/observer",
        &body.to_string(),
        Instant::now() + Duration::from_secs(timeout),
        Some(&token),
    )?;
    if code != 200 || value["ok"] != true {
        return Err(value["message"]
            .as_str()
            .unwrap_or("请检查本地服务后重试观察辅助连接。")
            .into());
    }
    Ok(value)
}

pub fn active() -> bool {
    ACTIVE.load(Ordering::Acquire)
}

fn stop_inner(log: &DesktopLog, force: bool) -> Result<(), String> {
    if force || ACTIVE.load(Ordering::Acquire) {
        request(log, serde_json::json!({"action":"stop"}))?;
        ACTIVE.store(false, Ordering::Release);
    }
    Ok(())
}

/// The caller holds the game/observer operation lock.
pub fn finish_locked(log: &DesktopLog) -> Result<(), String> {
    let observer = stop_inner(log, false);
    let hud = crate::observer_hud::restore(log);
    production_exit::cleanup_results(observer, hud)
}

fn verify_session(
    app: &tauri::AppHandle,
    ticket: u64,
    context: &serde_json::Value,
    game: &managed_cs2::WorkspaceProcess,
) -> Result<(), String> {
    app.state::<production_exit::ExitGate>()
        .check_ticket(ticket)?;
    app.state::<crate::updates::PendingUpdate>().check()?;
    if !app
        .state::<crate::host_state::HostState>()
        .visible
        .load(Ordering::Acquire)
        || !game.is_running()
    {
        return Err("游戏或工作区已变化，请重新连接观察辅助。".into());
    }
    let log = app.state::<DesktopLog>();
    let store = crate::cs2_session::SessionStore::new(log.state_root.clone());
    let current = store
        .load()?
        .ok_or("游戏会话已变化，请重新连接观察辅助。")?;
    let process = managed_cs2::verified_session_process(&current, &log)?;
    if [
        "pid",
        "created",
        "preparationId",
        "executable",
        "mulnxLaunch",
        "nativeHudToggle",
        "spectatorCfg",
    ]
    .iter()
    .any(|key| current[*key] != context[*key])
        || !process.is_some_and(|process| {
            process.pid == game.pid && process.created == game.created && process.is_running()
        })
    {
        return Err("游戏会话已变化，请重新连接观察辅助。".into());
    }
    Ok(())
}

pub fn pulse_locked(app: &tauri::AppHandle, cs2: &managed_cs2::ManagedCs2) {
    if !ACTIVE.load(Ordering::Acquire) {
        return;
    }
    let log = app.state::<DesktopLog>();
    let valid = cs2
        .workspace_process()
        .ok()
        .flatten()
        .is_some_and(|game| game.is_running());
    let result = if valid {
        request(&log, serde_json::json!({"action":"pulse"})).and_then(|value| {
            if value["enabled"] == false {
                stop_inner(&log, false)
            } else {
                Ok(())
            }
        })
    } else {
        stop_inner(&log, false)
    };
    if let Err(error) = result {
        log.event("observer_lease", "failure", Some(&error));
    }
}

#[tauri::command]
pub async fn observer_command(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    endpoint: Option<String>,
    password: Option<String>,
    expected_revision: Option<String>,
) -> Result<serde_json::Value, String> {
    if !["main", "workspace-left", "workspace-dock"].contains(&window.label())
        && !(window.label() == "tool-review"
            && matches!(action.as_str(), "start-configured" | "connection-mode")
            && window.url().ok().is_some_and(|url| {
                url.path() == "/workspace/review"
                    && matches!(
                        url.query(),
                        Some("kind=connection" | "kind=next-connection")
                    )
            }))
    {
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
                let ticket = app.state::<production_exit::ExitGate>().presentation_ticket()?;
                let _operation = cleanup_operation();
                app.state::<production_exit::ExitGate>().check_ticket(ticket)?;
                return stop_inner(&log, true);
            }
            if action == "restore-hud" {
                let ticket = app.state::<production_exit::ExitGate>().presentation_ticket()?;
                app.state::<crate::updates::PendingUpdate>().check()?;
                let _operation = operation()?;
                app.state::<production_exit::ExitGate>().check_ticket(ticket)?;
                return crate::observer_hud::restore(&log);
            }
            if action == "preflight" {
                let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let cs2 = managed.lock().map_err(|_| "请等待游戏操作完成后重试。")?;
                let native = cs2.console_source()?.is_some_and(|(context, _)| context["nativeHudToggle"] == true && context["spectatorCfg"] == true);
                let prefer_mulnx = !native && cs2.status()?["preferMulnx"] == true;
                drop(cs2);
                if !native { crate::observer_hud::preflight(&log, prefer_mulnx)?; }
                return Ok(());
            }
            if action != "start" && action != "start-configured" { return Err("请选择连接或停止观察辅助。".into()); }
            let ticket = app.state::<production_exit::ExitGate>().presentation_ticket()?;
            app.state::<crate::updates::PendingUpdate>().check()?;
            if !app.state::<crate::host_state::HostState>().visible.load(Ordering::Acquire) {
                return Err("请打开制播工作台后连接早源。".into());
            }
            let _operation = operation()?;
            app.state::<production_exit::ExitGate>().check_ticket(ticket)?;
            let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let cs2 = managed.lock().map_err(|_| "请等待游戏操作完成后重试。")?;
            let (context, game) = cs2.console_source()?.ok_or("请先从工作台启动或接入 CS2。")?;
            if !game.is_running() { return Err("请先启动 CS2，再连接观察辅助。".into()); }
            let executable = context["executable"].as_str().ok_or("请确认 CS2 安装位置。")?;
            let use_mulnx = action == "start-configured" && crate::mulnx_launch::observer_control_available(&cs2, &log);
            drop(cs2);
            let verify = || verify_session(&app, ticket, &context, &game);
            verify()?;
            if action == "start-configured" {
                let job = observer_job::name(&log.session_id);
                automation = Some(use_mulnx);
                let game_key = format!("{}-{}", game.pid, game.created);
                let native_hud_toggle = context["nativeHudToggle"] == true && context["spectatorCfg"] == true;
                let mut intent = serde_json::json!({"action":"prepare","game":game_key,"job":job,"useMulnx":use_mulnx,"nativeHudToggle":native_hud_toggle});
                if let Some(revision) = expected_revision { intent["expectedRevision"] = revision.into(); }
                let preparation = request(&log, intent)?;
                verify()?;
                if native_hud_toggle && use_mulnx && crate::observer_hud::preflight(&log, true)? {
                    verify()?;
                    crate::observer_hud::initialize(&log, std::path::Path::new(executable), &game)?;
                    verify()?;
                }
                if preparation["enabled"] != true { stop_inner(&log, false)?; return Ok(()); }
                if preparation["reuse"] == true { ACTIVE.store(true, Ordering::Release); return Ok(()); }
                let mut body = serde_json::json!({"action":"start-configured","executable":executable,
                    "game":game_key,"job":job,"revision":preparation["revision"],"useMulnx":use_mulnx,"nativeHudToggle":native_hud_toggle});
                if preparation["hideGameHud"] == true {
                    body["hudOriginal"] = crate::observer_hud::snapshot(&log, std::path::Path::new(executable), &game)?.into();
                } else if !native_hud_toggle { crate::observer_hud::restore(&log)?; }
                verify()?;
                ACTIVE.store(true, Ordering::Release);
                // Keep the accepted program operation and HUD journal on auxiliary failure.
                // Exit restores the original value; retry reuses the same game transaction.
                request(&log, body)?;
                if let Err(error) = verify() {
                    stop_inner(&log, false)?;
                    return Err(error);
                }
                return Ok(());
            }
            let endpoint = endpoint.ok_or("请填写授权的 GOTV 地址。")?;
            verify()?;
            ACTIVE.store(true, Ordering::Release);
            request(&log, serde_json::json!({"action":"start", "executable":executable,
                "job":observer_job::name(&log.session_id),
                "endpoint":endpoint, "password":password.unwrap_or_default()}))?;
            if let Err(error) = verify() {
                stop_inner(&log, false)?;
                return Err(error);
            }
            Ok(())
        })();
        log.event("observer_workspace", if result.is_ok() { "success" } else { "failure" }, result.as_ref().err().map(String::as_str));
        result.map(|()| serde_json::json!({"useMulnx":automation}))
    }).await.map_err(|error| format!("观察辅助操作需要重试：{error}"))?
}
