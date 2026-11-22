//! Host exit and managed CS2 cleanup preserve Companion production safety boundaries.
use crate::companion_http::{request, request_with_identity, runtime_token};
use crate::cs2_camera::disconnect_camera;
use crate::desktop_types::{WorkspaceExitStage, WorkspaceExitStatus};
use crate::{
    cs2_activity, demo_test, managed_cs2, observer_workspace, startup_log::DesktopLog,
    workspace_presentation,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Default)]
pub struct VerifiedStop(AtomicBool);
impl VerifiedStop {
    pub fn mark(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn complete(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Default)]
pub struct ExitGate {
    active: AtomicBool,
    generation: AtomicU64,
    publication: Mutex<()>,
}
impl ExitGate {
    pub fn begin(&self) -> bool {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        if self.active.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
        true
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub fn check(&self) -> Result<(), String> {
        if self.active.load(Ordering::Acquire) {
            Err("Mizar 正在退出，请完成收尾后再启动。".into())
        } else {
            Ok(())
        }
    }
    /// Capture before readiness/window creation. Even a completed exit invalidates this entry.
    pub fn presentation_ticket(&self) -> Result<u64, String> {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        self.check()?;
        Ok(self.generation.load(Ordering::Acquire))
    }
    pub fn check_ticket(&self, ticket: u64) -> Result<(), String> {
        self.check()?;
        if self.generation.load(Ordering::Acquire) != ticket {
            return Err("此前的进入操作已因退出而取消，请重新进入工作台。".into());
        }
        Ok(())
    }
    pub fn commit<T>(
        &self,
        ticket: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        self.check_ticket(ticket)?;
        action()
    }
    /// Serialize the actual main-thread window publication with starting an exit.
    pub fn publish(&self, ticket: u64, present: impl FnOnce()) -> Result<(), String> {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        self.check()?;
        if self.generation.load(Ordering::Acquire) != ticket {
            return Err("此前的进入操作已因退出而取消，请在准备中心重新进入工作台。".into());
        }
        present();
        Ok(())
    }
    pub fn cancel(&self) {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        self.active.store(false, Ordering::Release);
    }
}

/// UI feedback only; production and restoration facts remain with their owners.
impl Default for WorkspaceExitStatus {
    fn default() -> Self {
        Self {
            busy: false,
            stage: WorkspaceExitStage::Idle,
            message: None,
            window_message: None,
        }
    }
}
#[derive(Default)]
pub struct WorkspaceExit(std::sync::Mutex<WorkspaceExitStatus>);
impl WorkspaceExit {
    pub fn status(&self) -> WorkspaceExitStatus {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn stage(&self, stage: WorkspaceExitStage) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = WorkspaceExitStatus {
            busy: true,
            stage,
            message: None,
            window_message: None,
        };
    }
    pub fn complete(&self, result: &Result<(), String>) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.busy = false;
        state.message = result
            .as_ref()
            .err()
            .map(|error| user_facing_failure(error));
        if result.is_ok() {
            state.stage = WorkspaceExitStage::Idle;
        }
    }
}

/// Keep internal ownership/state-machine terms out of operator-facing exit copy.
/// The raw error remains in the diagnostic log; this is presentation only.
pub fn user_facing_failure(error: &str) -> String {
    const MAPPINGS: &[(&str, &str)] = &[
        (
            "受管游戏来源",
            "这次结束制作没有完成。请先退出 CS2，再重试；仍然失败时重新打开 Mizar。",
        ),
        (
            "受管来源",
            "游戏配置恢复没有完成。请点“重试结束制作”；仍然失败时重新打开 Mizar。",
        ),
        (
            "受管游戏",
            "当前游戏状态已经变化。请确认 CS2 已退出后重试。",
        ),
        (
            "本场回收资格",
            "本场收尾还没有确认。请重试；仍然失败时导出诊断。",
        ),
        (
            "退出资格",
            "本场收尾还没有确认。请重试；仍然失败时导出诊断。",
        ),
        ("游戏实例", "CS2 状态已经变化。请重新检查游戏后重试。"),
        ("本地服务", "Mizar 后台服务连接中断。请重新打开 Mizar。"),
        (
            "制播服务启动超时",
            "Mizar 后台服务启动超时。请重新打开 Mizar；多次失败请导出诊断。",
        ),
    ];
    for &(needle, copy) in MAPPINGS {
        if error.contains(needle) {
            return copy.to_string();
        }
    }
    let lower = error.to_ascii_lowercase();
    if [
        "companion",
        "host",
        "ticket",
        "qualification",
        "generation",
        "journal",
    ]
    .iter()
    .any(|term| lower.contains(*term))
    {
        return "Mizar 后台服务没有完成操作。请重试；仍然失败时导出诊断。".into();
    }
    error.to_string()
}

/// Releasing a failed or completed workspace operation must also allow retry.
pub struct WorkspaceExitGuard<'a>(pub &'a ExitGate);
impl Drop for WorkspaceExitGuard<'_> {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub fn finish_then_restore(
    finish: impl FnOnce() -> Result<(), String>,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    finish()?;
    restore()
}

pub fn restore_then_cleanup(
    restore: impl FnOnce() -> Result<(), String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let restoration = restore();
    let cleanup = cleanup();
    cleanup_results(restoration, cleanup)
}

/// Both independent cleanups have already run; preserve every failure for retry/diagnostics.
pub fn cleanup_results(
    first: Result<(), String>,
    second: Result<(), String>,
) -> Result<(), String> {
    match (first, second) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(first), Err(second)) => Err(format!("{first}\n{second}")),
    }
}

const EXIT_ENDPOINT: &str = "/operator/runtime/local-match-exit";
const EXIT_UNCONFIRMED: &str =
    "收尾已执行，但游戏退出和本场收尾未确认。请重试结束游戏；再次失败时查看诊断。";

fn exit_request(log: &DesktopLog, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = runtime_token(log)?;
    let (status, response) = request_with_identity(
        log,
        "POST",
        EXIT_ENDPOINT,
        &body.to_string(),
        Instant::now() + Duration::from_secs(5),
        Some(&token),
    )?;
    if status != 200 {
        // Only status is diagnostic: server payloads can contain private qualification data.
        log.event(
            "production_finish",
            "failure",
            Some(&format!("phase=local_match_exit_http; status={status}")),
        );
        return Err("本场收尾校验未完成。请重试；再次失败时查看诊断。".into());
    }
    Ok(response)
}

pub(crate) fn managed_source_request_status(
    log: &DesktopLog,
    body: serde_json::Value,
) -> Result<(u16, serde_json::Value), String> {
    let token = runtime_token(log)?;
    request_with_identity(
        log,
        "POST",
        "/operator/runtime/managed-source",
        &body.to_string(),
        Instant::now() + Duration::from_secs(5),
        Some(&token),
    )
}

pub(crate) fn managed_source_request_detail(
    log: &DesktopLog,
    body: serde_json::Value,
) -> Result<Result<serde_json::Value, (u16, serde_json::Value, String)>, String> {
    let action = body["action"].as_str().unwrap_or("unknown").to_owned();
    let phase = body["phase"].as_str().unwrap_or("-").to_owned();
    let (status, response) = managed_source_request_status(log, body)?;
    if status != 200 {
        let error_code = response["error"].as_str().unwrap_or("unknown");
        log.event(
            "managed_source",
            "failure",
            Some(&format!(
                "action={action}; phase={phase}; status={status}; error={error_code}"
            )),
        );
        let message = match (action.as_str(), error_code) {
            ("retire", _) => "游戏配置与遥测来源收尾尚未确认，请确认 CS2 已退出后重试。",
            (_, "managed_source_not_retired") | (_, "managed_retirement_in_progress") => {
                "上一场受管游戏来源尚未退场，请先结束上一场收尾后重试。"
            }
            (_, "managed_source_selection_changed") | (_, "managed_source_resume_unavailable") => {
                "当前比赛或制作会话已变化，受管游戏遥测需要重新绑定。"
            }
            (_, "managed_source_identity_changed") => "受管游戏进程或来源身份已变化，请重新检查。",
            _ => "受管游戏来源未能确认，请重试。",
        };
        return Ok(Err((status, response, message.to_owned())));
    }
    Ok(Ok(response))
}

pub(crate) fn managed_source_request(
    log: &DesktopLog,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    managed_source_request_detail(log, body)?.map_err(|(_, _, message)| message)
}

pub(crate) fn abort_retirement(log: &DesktopLog, ticket: &str) {
    match managed_source_request_status(
        log,
        serde_json::json!({"action":"retire","phase":"abort","ticket":ticket}),
    ) {
        Ok((200, _)) => {}
        Ok((status, _)) => log.event(
            "managed_source",
            "failure",
            Some(&format!("phase=abort; status={status}")),
        ),
        Err(_) => {}
    }
}

pub(crate) fn confirm_retirement(log: &DesktopLog, ticket: &str) -> Result<(), String> {
    let result = ["settle", "confirm"].into_iter().try_for_each(|phase| {
        let response = managed_source_request(
            log,
            serde_json::json!({"action":"retire","phase":phase,"ticket":ticket}),
        )?;
        if response["ok"] != true {
            return Err("游戏配置恢复没有确认。请重试。".into());
        }
        Ok(())
    });
    if result.is_err() {
        abort_retirement(log, ticket);
    }
    result
}

fn prepare_local_match_exit(
    log: &DesktopLog,
) -> Result<Option<crate::lifecycle_contract::Qualification>, String> {
    let response = exit_request(log, serde_json::json!({"action": "prepare"}))?;
    crate::lifecycle_contract::Qualification::from_response(&response)
}

fn confirm_local_match_exit(
    log: &DesktopLog,
    qualification: crate::lifecycle_contract::Qualification,
) -> Result<(), String> {
    let response = exit_request(
        log,
        serde_json::json!({"action": "confirm", "qualification": qualification.as_value()}),
    )?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err("本场收尾响应无效。请重试；再次失败时查看诊断。".into())
    }
}

fn settle_local_match_exit(
    log: &DesktopLog,
    qualification: &crate::lifecycle_contract::Qualification,
) -> Result<(), String> {
    let response = exit_request(
        log,
        serde_json::json!({"action": "settle", "qualification": qualification.as_value()}),
    )?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err("本场退出状态未能确认。".into())
    }
}

pub fn invalidate_local_match_exit(log: &DesktopLog) -> Result<(), String> {
    let response =
        exit_request(log, serde_json::json!({"action": "invalidate"})).map_err(|_| {
            "无法撤销上一场收尾确认，CS2 尚未启动。请重试；再次失败时查看诊断。".to_string()
        })?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err("无法确认上一场收尾已撤销，CS2 尚未启动。请重试；再次失败时查看诊断。".into())
    }
}

#[must_use]
pub struct ManagedGameHandoff(Result<(), String>);

impl ManagedGameHandoff {
    pub fn confirm(self) -> Result<(), String> {
        self.0
    }

    pub fn record_deferred(self, log: &DesktopLog, stage: &str) {
        if let Err(error) = self.0 {
            log.event(stage, "deferred", Some(&error));
        }
    }
}

/// Caller holds the managed CS2 mutex across prepare, native cleanup and confirmation.
pub fn finish_managed_game(
    log: &DesktopLog,
    finish_and_verify: impl FnOnce() -> Result<(), String>,
) -> Result<ManagedGameHandoff, String> {
    let retirement = managed_source_request(
        log,
        serde_json::json!({"action":"retire","phase":"prepare"}),
    );
    let qualification = prepare_local_match_exit(log);
    if let Err(error) = finish_and_verify() {
        // Local cleanup failed before the source handshake could finish. Do not
        // leave the retirement open: a later commit or production session would
        // make its ticket impossible to settle.
        if let Some(ticket) = retirement
            .as_ref()
            .ok()
            .and_then(|value| value["ticket"].as_str())
        {
            abort_retirement(log, ticket);
        }
        return Err(error);
    }
    let local = match qualification {
        Ok(Some(qualification)) => settle_local_match_exit(log, &qualification)
            .and_then(|()| confirm_local_match_exit(log, qualification))
            .map_err(|_| EXIT_UNCONFIRMED.to_string()),
        Ok(None) => Ok(()),
        Err(_) => Err(EXIT_UNCONFIRMED.into()),
    };
    let source = (|| -> Result<(), String> {
        let retirement = retirement.as_ref().map_err(|error| error.to_string())?;
        let ticket = retirement["ticket"]
            .as_str()
            .ok_or("游戏配置恢复没有完成。请重试。")?;
        confirm_retirement(log, ticket)
    })();
    Ok(ManagedGameHandoff(cleanup_results(local, source)))
}

/// Replacement belongs to this preparation task, even after its workspace session opens.
pub fn prepare_external_entry(
    log: &DesktopLog,
    expected_revision: &str,
    preparation_id: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let (code, view) = request(log, "GET", "/local/v1/production", "", deadline)?;
    let view = crate::lifecycle_contract::production_view(&view)?;
    if code != 200 || view.revision != expected_revision {
        return Err("制作状态已变化，请重新打开工作台。".into());
    }
    if view.mode != "preparation" {
        let (code, status) = request(
            log,
            "GET",
            &format!("/local/v1/preparation-status?preparationId={preparation_id}"),
            "",
            deadline,
        )?;
        if code != 200 || !crate::lifecycle_contract::cancellation_entered(&status)? {
            return Err("游戏启动任务已变化，请重新打开工作台。".into());
        }
    }
    disconnect_camera(log)?;
    invalidate_local_match_exit(log)
}

pub fn finish_companion(log: &DesktopLog) -> Result<(), String> {
    finish_production(log, "shutdown")
}

pub fn finish_workspace_production(log: &DesktopLog) -> Result<(), String> {
    finish_production(log, "finish")
}

pub fn set_exit_intent(log: &DesktopLog, action: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let (status, state) = request(log, "GET", "/local/v1/production", "", deadline)?;
    if status != 200 {
        return Err("无法读取制作状态，游戏仍保留。".into());
    }
    let view = crate::lifecycle_contract::production_view(&state)?;
    let body = serde_json::json!({"action": action, "expectedRevision": view.revision}).to_string();
    let (status, response) = request(log, "POST", "/operator/production", &body, deadline)?;
    if status != 200 {
        return Err("无法确认退出准备，请重试。".into());
    }
    let actual = crate::lifecycle_contract::production_view(&response)?;
    if actual.revision != view.revision || actual.mode != view.mode {
        return Err("无法确认退出准备，请重试。".into());
    }
    Ok(())
}

fn finish_production(log: &DesktopLog, action: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    for _ in 0..3 {
        let (status, state) = request(log, "GET", "/local/v1/production", "", deadline)?;
        if status != 200 {
            log.event(
                "production_finish",
                "failure",
                Some(&format!("phase=state_http; status={status}")),
            );
            return Err("无法读取制作状态，游戏仍保留。".into());
        }
        let view = crate::lifecycle_contract::production_view(&state)?;
        let body =
            serde_json::json!({"action": action, "expectedRevision": view.revision}).to_string();
        let (status, result) = request(log, "POST", "/operator/production", &body, deadline)?;
        if status == 200
            && crate::lifecycle_contract::production_view(&result)?.mode == "preparation"
        {
            return Ok(());
        }
        if crate::lifecycle_contract::is_retryable(status, &result, "productionConflict") {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        log.event(
            "production_finish",
            "failure",
            Some(&format!("phase=finish_http; status={status}")),
        );
        return Err(result["message"]
            .as_str()
            .unwrap_or("安全切场或数据源释放未完成。请修复后重试退出。")
            .into());
    }
    Err("制作仍在处理操作，请稍后重试退出。".into())
}

pub(crate) async fn finish_workspace(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    confirm_steam_cancelled: Option<bool>,
    diagnostic_operation_id: Option<String>,
    diagnostic_task_id: Option<String>,
    diagnostic_trigger: Option<String>,
    retire_preparation: fn(),
) -> Result<(), String> {
    let diagnostic_log = app.state::<DesktopLog>().inner().clone();
    let command_log = diagnostic_log.clone();
    let native_operation_id = diagnostic_operation_id.clone();
    let native_task_id = diagnostic_task_id.clone();
    let native_trigger = diagnostic_trigger.clone();
    let diagnostic_result: Result<(), String> = async move {
    if !["main", "workspace-left", "workspace-dock"].contains(&window.label()) {
        return Err("请在准备中心或工作台退出本次制作。".into());
    }
    let gate = app.state::<crate::production_exit::ExitGate>();
    if !gate.begin() {
        return Err("正在退出，请等待收尾结果。".into());
    }
    let _gate = crate::production_exit::WorkspaceExitGuard(&gate);
    let feedback = app.state::<crate::production_exit::WorkspaceExit>();
    feedback.stage(WorkspaceExitStage::Checking);
    command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || app.state::<DesktopLog>().event("workspace_exit", "begin", Some(&serde_json::json!({"phase":"checking", "confirmSteamCancelled":confirm_steam_cancelled}).to_string())));
    // Keep a visible waiting record if a native lock, process or presentation call stalls.
    let (waiting_done, waiting) = std::sync::mpsc::channel::<()>();
    let waiting_host = app.clone();
    let waiting_log = command_log.clone();
    let waiting_task = native_task_id.clone();
    let waiting_trigger = native_trigger.clone();
    let waiting_operation = native_operation_id.clone();
    std::thread::spawn(move || waiting_log.with_task(waiting_task.as_deref(), waiting_operation.as_deref(), waiting_trigger.as_deref(), || {
        let started = std::time::Instant::now();
        while waiting.recv_timeout(Duration::from_secs(5)) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            let phase = waiting_host.state::<crate::production_exit::WorkspaceExit>().status().stage;
            waiting_host.state::<DesktopLog>().event("workspace_exit", "waiting", Some(&serde_json::json!({"phase":phase,"elapsedMs":started.elapsed().as_millis()}).to_string()));
        }
    }));
    // This task belongs to Host, so hiding or closing a WebView cannot lose it.
    let host = app.clone();
    let result = tauri::async_runtime::spawn_blocking({ let command_log = command_log.clone(); let native_operation_id = native_operation_id.clone(); let native_task_id = native_task_id.clone(); let native_trigger = native_trigger.clone(); move || -> Result<(), String> {
        command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || {
        let feedback = host.state::<crate::production_exit::WorkspaceExit>();
        let log = host.state::<DesktopLog>();
        let _operation = observer_workspace::cleanup_operation();
        let managed = host.state::<Mutex<managed_cs2::ManagedCs2>>();
        let mut cs2 = log.step("workspace_exit_lock", || managed.lock().map_err(|error| command_log.preserve_error("finish_workspace", native_operation_id.as_deref(), &error, "CS2 配置状态不可用。")))?;
        // Freeze automatic work before local cleanup. Demo recovery and production
        // finish share Companion's mutation gate, so they must not run concurrently.
        let _ = log.step("workspace_begin_exit", || crate::production_exit::set_exit_intent(&log, "begin-exit"));
        let activity = host.state::<cs2_activity::Activity>();
        // Open the visible recovery owner before any potentially slow cleanup.
        // A presentation failure cannot skip safe production or game cleanup.
        if let Err(error) = workspace_presentation::open_main(host.clone(), None, None) {
            log.event(
                "production_finish",
                "failure",
                Some(&format!("phase=workspace_recovery_window; cause={error}")),
            );
        }
        if confirm_steam_cancelled != Some(true) {
            if let Ok(startup) = cs2.startup_recovery_status() {
                if startup.uncertain && !startup.running {
                    return Err("CS2 还在启动。请等待启动完成，或先取消启动请求并确认后再结束制作。".into());
                }
            }
        }
        feedback.stage(WorkspaceExitStage::Restoration);
        let mut native_game_finished = false;
        let game = crate::production_exit::restore_then_cleanup(
        || log.step("workspace_exit_observer", || observer_workspace::finish_locked(&log)),
        || -> Result<(), String> {
        // Host-owned recovery evidence determines local work even when Companion is offline.
        let restoring_demo = cs2.has_demo_journal()? || demo_test::requires_recovery(&log, None);
        let mut finish_game = || -> Result<(), String> {
            let _activity = activity.begin(2);
            if confirm_steam_cancelled == Some(true) {
                log.step("workspace_exit_restore_backup", || cs2.restore_backup(true))?;
            }
            log.step("workspace_exit_game_finish", || {
                if restoring_demo { cs2.finish() } else { cs2.finish_for_production() }
            })
        };
        if restoring_demo {
            finish_game()?;
        } else {
            finish_managed_game(&log, finish_game)?
                .record_deferred(&log, "workspace_exit_managed_source");
        }
        native_game_finished = true;
        Ok(())
        });
        workspace_presentation::refresh_finished_window_feedback(&host, &cs2);
        drop(cs2);
        if native_game_finished { retire_preparation(); }
        feedback.stage(WorkspaceExitStage::Presentation);
        // Retry presentation after cleanup; an earlier transient window failure
        // must not prevent returning to preparation once the game is finished.
        let presentation = log.step("workspace_exit_presentation", || workspace_presentation::present_production_inner_checked(&host, false, None, None));
        // Run after local cleanup even if restoration failed; remote work cannot
        // delay stopping the owned game or restoring its temporary configuration.
        let production = crate::production_exit::finish_workspace_production(&log);
        crate::production_exit::cleanup_results(production, crate::production_exit::cleanup_results(game, presentation))
        })
    } })
    .await
    .unwrap_or_else(|error| {
        app.state::<DesktopLog>().event(
            "production_finish",
            "failure",
            Some(&format!("phase=workspace_task; cause={error}")),
        );
        Err("退出任务中断，收尾结果待确认。请重试退出；再次失败时导出诊断。".into())
    });
    let intent_host = app.clone();
    let intent_result = tauri::async_runtime::spawn_blocking(move || {
        crate::production_exit::set_exit_intent(&intent_host.state::<DesktopLog>(), "cancel-exit")
    }).await.unwrap_or_else(|_| Err("制作退出状态未能恢复，请重试。".into()));
    let result = crate::production_exit::cleanup_results(result, intent_result);
    if let Err(error) = &result {
        app.state::<DesktopLog>().event(
            "production_finish",
            "failure",
            Some(&format!(
                "phase=workspace_{}; cause={error}",
                feedback.status().stage.name()
            )),
        );
    }
    command_log.with_task(native_task_id.as_deref(), native_operation_id.as_deref(), native_trigger.as_deref(), || app.state::<DesktopLog>().event("workspace_exit", if result.is_ok() { "success" } else { "failure" }, Some(&serde_json::json!({"phase":feedback.status().stage,"error":result.as_ref().err()}).to_string())));
    let _ = waiting_done.send(());
    feedback.complete(&result);
    if result.is_err() {
        // Keep the original local failure; never replace it with window errors.
        let _ = workspace_presentation::open_main(app.clone(), None, None);
        if let Err(window_error) = workspace_presentation::open_tool(app.clone(), "review".into(), Some("exit".into()), None).await {
            command_log.event("workspace_exit_alert", "failure", Some(&window_error));
        }
    }
    // Preserve the command result too; callers must not announce false success.
    result

    }.await;
    diagnostic_log.with_task(
        diagnostic_task_id.as_deref(),
        diagnostic_operation_id.as_deref(),
        diagnostic_trigger.as_deref(),
        || {
            diagnostic_log.native_outcome(
                "finish_workspace",
                diagnostic_operation_id.as_deref(),
                &diagnostic_result,
            )
        },
    );
    diagnostic_result
}
