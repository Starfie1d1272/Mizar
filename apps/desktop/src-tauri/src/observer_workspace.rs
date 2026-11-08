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
static LEASE: Mutex<Option<HostLease>> = Mutex::new(None);

struct HostLease {
    game: managed_cs2::WorkspaceProcess,
    context: serde_json::Value,
    ticket: u64,
    token: String,
    confirmed: Instant,
    failure_logged: bool,
}

fn accept_lease(
    game: &managed_cs2::WorkspaceProcess,
    context: &serde_json::Value,
    ticket: u64,
    response: &serde_json::Value,
) -> Result<(), String> {
    let token = response["leaseToken"]
        .as_str()
        .ok_or("提前提示连接未确认，请重新连接。")?;
    *LEASE.lock().map_err(|_| "提前提示连接状态不可用。")? = Some(HostLease {
        game: game.clone(),
        context: context.clone(),
        ticket,
        token: token.to_owned(),
        confirmed: Instant::now(),
        failure_logged: false,
    });
    Ok(())
}

fn revoke_lease() {
    // Wait only for the bounded pulse, never for a game operation.
    *LEASE.lock().unwrap_or_else(|error| error.into_inner()) = None;
}

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
pub(crate) fn clear_operation_poison() {
    OPERATION.clear_poison();
}
pub(crate) fn try_cleanup_operation() -> Option<std::sync::MutexGuard<'static, ()>> {
    match OPERATION.try_lock() {
        Ok(guard) => Some(guard),
        Err(std::sync::TryLockError::Poisoned(error)) => Some(error.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
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
    revoke_lease();
    if force || ACTIVE.load(Ordering::Acquire) {
        request(
            log,
            serde_json::json!({"action":"stop", "reason":"production-ended"}),
        )?;
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
    require_visible: bool,
) -> Result<(), String> {
    app.state::<production_exit::ExitGate>()
        .check_ticket(ticket)?;
    app.state::<crate::updates::PendingUpdate>().check()?;
    if (require_visible
        && !app
            .state::<crate::host_state::HostState>()
            .visible
            .load(Ordering::Acquire))
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
        "hudRecoveryWarning",
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

/// Renewal and revocation share only this lease lock, not OPERATION or ManagedCs2.
pub fn pulse(app: &tauri::AppHandle) {
    let mut state = match LEASE.lock() {
        Ok(state) => state,
        Err(error) => {
            *error.into_inner() = None;
            return;
        }
    };
    let Some(lease) = state.as_mut() else {
        return;
    };
    let log = app.state::<DesktopLog>();
    // The held handle prevents PID reuse; the persisted identity and exit ticket
    // prevent a still-running old game from extending a replaced session.
    // Hiding panels is presentation only; exit tickets still revoke production.
    if let Err(error) = verify_session(app, lease.ticket, &lease.context, &lease.game, false) {
        let token = lease.token.clone();
        *state = None;
        // A scoped late revoke cannot touch a replacement lease. Do not make
        // a new verified intent wait for old component cleanup/network I/O.
        drop(state);
        log.event("observer_lease", "failure", Some(&error));
        if let Err(error) = request(
            &log,
            serde_json::json!({"action":"stop", "leaseToken":token, "reason":"host-invalid"}),
        ) {
            log.event("observer_lease_revoke", "failure", Some(&error));
        }
        return;
    }
    if lease.confirmed.elapsed() > Duration::from_secs(30) {
        *state = None;
        log.event(
            "observer_lease",
            "failure",
            Some("lease-recovery-window-expired"),
        );
        return;
    }
    match request(
        &log,
        serde_json::json!({"action":"pulse", "leaseToken":lease.token}),
    ) {
        Ok(value) if value["enabled"] == false => {
            *state = None;
        }
        Ok(_) => {
            if lease.failure_logged {
                log.event("observer_lease", "success", Some("renewed"));
            }
            lease.confirmed = Instant::now();
            lease.failure_logged = false;
        }
        Err(error) => {
            if !lease.failure_logged {
                log.event("observer_lease", "failure", Some(&error));
            }
            lease.failure_logged = true;
        }
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
        && !(window.label() == "tool-connection"
            && matches!(
                action.as_str(),
                "start-configured" | "connection-mode" | "stop"
            )
            && window
                .url()
                .ok()
                .is_some_and(|url| url.path() == "/workspace/connection" && url.query().is_none()))
    {
        return Err("请在制播工作台操作观察辅助。".into());
    }
    let action_ticket = if matches!(
        action.as_str(),
        "stop" | "restore-hud" | "start" | "start-configured"
    ) {
        Some(
            app.state::<production_exit::ExitGate>()
                .presentation_ticket()?,
        )
    } else {
        None
    };
    if action == "start-configured" && crate::preparation_task::waiting_for_game()? {
        let ticket = action_ticket.ok_or("连接操作已失效。")?;
        app.state::<production_exit::ExitGate>()
            .check_ticket(ticket)?;
        // The settings owner already holds the intent. The preparation task resumes it
        // from the latest owner view once this same game's verified startup completes.
        return Ok(serde_json::json!({"pending":true}));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let log = app.state::<DesktopLog>();
        log.event("observer_workspace", "begin", Some(&format!("action={action}")));
        let mut automation = None;
        let mut hud_warning = None;
        let result: Result<(), String> = (|| {
            if action == "connection-mode" {
                if crate::preparation_task::waiting_for_game()? {
                    return Ok(());
                }
                let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
                let cs2 = managed.try_lock().map_err(|_| "请等待游戏操作完成后重试。")?;
                let game = crate::mulnx_launch::observer_control_snapshot(&cs2, &log);
                drop(cs2);
                automation = Some(game.is_some_and(|game| crate::mulnx_launch::observer_gateway_available(&game, &log)));
                return Ok(());
            }
            if action == "stop" {
                let ticket = action_ticket.ok_or("观察辅助操作已失效。")?;
                let _operation = cleanup_operation();
                app.state::<production_exit::ExitGate>().check_ticket(ticket)?;
                let mut intent = serde_json::json!({"action":"stop"});
                if let Some(revision) = expected_revision { intent["expectedRevision"] = revision.into(); }
                request(&log, intent)?;
                revoke_lease();
                ACTIVE.store(false, Ordering::Release);
                return Ok(());
            }
            if action == "restore-hud" {
                let ticket = action_ticket.ok_or("观察辅助操作已失效。")?;
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
            let ticket = action_ticket.ok_or("观察辅助操作已失效。")?;
            app.state::<crate::updates::PendingUpdate>().check()?;
            if !app.state::<crate::host_state::HostState>().visible.load(Ordering::Acquire) {
                return Err("请先打开工作台，再连接提前提示。".into());
            }
            let _operation = operation()?;
            app.state::<production_exit::ExitGate>().check_ticket(ticket)?;
            let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
            let cs2 = managed.lock().map_err(|_| "请等待游戏操作完成后重试。")?;
            let (context, game) = cs2.console_source()?.ok_or("请先从工作台启动或接入 CS2。")?;
            if !game.is_running() { return Err("请先启动 CS2，再连接观察辅助。".into()); }
            let executable = context["executable"].as_str().ok_or("请确认 CS2 安装位置。")?;
            let control_game = if action == "start-configured" { crate::mulnx_launch::observer_control_snapshot(&cs2, &log) } else { None };
            drop(cs2);
            let use_mulnx = control_game.is_some_and(|game| crate::mulnx_launch::observer_gateway_available(&game, &log));
            let verify = || verify_session(&app, ticket, &context, &game, true);
            verify()?;
            if action == "start-configured" {
                let job = observer_job::name(&log.session_id);
                automation = Some(use_mulnx);
                let game_key = format!("{}-{}", game.pid, game.created);
                let native_hud_toggle = context["nativeHudToggle"] == true && context["spectatorCfg"] == true;
                // This is a per-intent capability, not a second settings source.
                // A missing original/readback disables only automatic HUD changes.
                let mut hud_available = context["consoleDiagnosticsWarning"].is_null() && context["hudRecoveryWarning"].is_null();
                let mut intent = serde_json::json!({"action":"prepare","game":game_key,"job":job,"useMulnx":use_mulnx,"nativeHudToggle":native_hud_toggle,"hudControlAvailable":hud_available});
                if let Some(revision) = expected_revision { intent["expectedRevision"] = revision.into(); }
                let mut preparation = request(&log, intent.clone())?;
                if preparation["hudControlUnavailable"] == true {
                    hud_warning = Some(if context["hudRecoveryWarning"].is_null() {
                        "本次控制台记录不可用，已跳过自动隐藏游戏原生 HUD；游戏、本机 HUD 和连接仍可使用。"
                    } else {
                        "上次 HUD 恢复记录不可用，已保留并跳过本次自动隐藏游戏原生 HUD；游戏、本机 HUD 和连接仍可使用。"
                    }.to_string());
                }
                verify()?;
                let mut hud_original = None;
                if hud_available {
                    let hud = (|| -> Result<(), String> {
                        if native_hud_toggle && use_mulnx && crate::observer_hud::preflight(&log, true)? {
                            crate::observer_hud::initialize(&log, std::path::Path::new(executable), &game)?;
                        } else if preparation["hideGameHud"] == true {
                            hud_original = Some(crate::observer_hud::snapshot(&log, std::path::Path::new(executable), &game)?);
                        }
                        Ok(())
                    })();
                    // Session identity failures remain fatal, including changes during a query.
                    verify()?;
                    if let Err(error) = hud {
                        hud_warning = Some(format!("自动隐藏游戏原生 HUD 未确认，连接继续；原值和未决恢复记录仍保留。{error}"));
                        hud_available = false;
                        intent["hudControlAvailable"] = false.into();
                        // A changed capability needs a fresh prepared token; never reuse
                        // one that authorized a different automatic HUD operation.
                        preparation = request(&log, intent)?;
                        verify()?;
                    }
                }
                if preparation["enabled"] != true { stop_inner(&log, false)?; return Ok(()); }
                if preparation["reuse"] == true {
                    accept_lease(&game, &context, ticket, &preparation)?;
                    ACTIVE.store(true, Ordering::Release);
                    return Ok(());
                }
                let mut body = serde_json::json!({"action":"start-configured","executable":executable,
                    "game":game_key,"job":job,"revision":preparation["revision"],"useMulnx":use_mulnx,"nativeHudToggle":native_hud_toggle,"hudControlAvailable":hud_available});
                if let Some(original) = hud_original {
                    body["hudOriginal"] = original.into();
                } else if hud_available && !native_hud_toggle {
                    if let Err(error) = crate::observer_hud::restore(&log) {
                        hud_warning = Some(format!("游戏原生 HUD 恢复未确认，连接继续；恢复记录仍保留。{error}"));
                    }
                }
                verify()?;
                revoke_lease();
                ACTIVE.store(true, Ordering::Release);
                // Keep the accepted program operation and HUD journal on auxiliary failure.
                // Exit restores the original value; retry reuses the same game transaction.
                let response = request(&log, body)?;
                if let Err(error) = verify() {
                    stop_inner(&log, false)?;
                    return Err(error);
                }
                accept_lease(&game, &context, ticket, &response)?;
                return Ok(());
            }
            let endpoint = endpoint.ok_or("请填写授权的 GOTV 地址。")?;
            verify()?;
            revoke_lease();
            ACTIVE.store(true, Ordering::Release);
            let response = request(&log, serde_json::json!({"action":"start", "executable":executable,
                "job":observer_job::name(&log.session_id),
                "endpoint":endpoint, "password":password.unwrap_or_default()}))?;
            if let Err(error) = verify() {
                stop_inner(&log, false)?;
                return Err(error);
            }
            accept_lease(&game, &context, ticket, &response)?;
            Ok(())
        })();
        log.event("observer_workspace", if result.is_ok() { "success" } else { "failure" }, result.as_ref().err().map(String::as_str));
        if let Some(warning) = &hud_warning {
            log.event("observer_hud", "degraded", Some(warning));
        }
        result.map(|()| serde_json::json!({"useMulnx":automation,"warning":hud_warning}))
    }).await.map_err(|error| format!("观察辅助操作需要重试：{error}"))?
}
