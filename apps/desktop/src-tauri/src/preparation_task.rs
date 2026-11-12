//! The desktop owns preparation independently of any webview lifetime.
use crate::desktop_types::{PreparationStatus, PreparationSteps};
use crate::host_state::HostState;
use crate::{
    entry_intent::EntryIntent, preparation_evidence, preparation_gate, production_exit,
    startup_log::DesktopLog,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    net::TcpStream,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryPhase {
    Preparing,
    Requested,
    Entered,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CancelPhase {
    Active,
    Requested,
    Confirmed,
}

#[derive(Clone)]
struct Task {
    id: String,
    revision: String,
    attempt: u64,
    preserve: bool,
    external: Option<(u32, String)>,
    running: bool,
    cancel_phase: CancelPhase,
    cancellation: Option<Arc<CancellationFlight>>,
    retire_requested: bool,
    obs: bool,
    obs_owned: bool,
    gsi: bool,
    game: bool,
    capture: bool,
    camera: bool,
    camera_uncertain: bool,
    entry_phase: EntryPhase,
    panel_epoch: Option<u64>,
    video_transaction: Option<String>,
    message: String,
}
impl Task {
    fn entered(&self) -> bool {
        self.entry_phase == EntryPhase::Entered
    }

    fn cancelled(&self) -> bool {
        self.cancel_phase != CancelPhase::Active
    }

    fn cancellation_confirmed(&self) -> bool {
        self.cancel_phase == CancelPhase::Confirmed
    }
}
static TASK: Mutex<Option<Task>> = Mutex::new(None);
// Cancellation belongs to the task; concurrent callers share its result.
#[derive(Default)]
struct CancellationFlight {
    result: Mutex<Option<Result<(), String>>>,
    completed: std::sync::Condvar,
    run_finished: std::sync::Condvar,
}
impl CancellationFlight {
    fn wait(&self) -> Result<(), String> {
        let mut result = self.result.lock().map_err(|_| "取消状态不可用。")?;
        while result.is_none() {
            result = self
                .completed
                .wait(result)
                .map_err(|_| "取消状态不可用。")?;
        }
        result.as_ref().expect("completed cancellation").clone()
    }
    fn wait_for_run(&self, id: &str) -> Result<(), String> {
        let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
        loop {
            match state.as_ref().filter(|task| task.id == id) {
                Some(task) if task.running => {
                    state = self
                        .run_finished
                        .wait(state)
                        .map_err(|_| "准备状态不可用。")?;
                }
                Some(_) => return Ok(()),
                None => return Err("本次准备任务不可用。".into()),
            }
        }
    }
    fn complete(&self, outcome: Result<(), String>) {
        let mut result = self
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *result = Some(outcome);
        self.completed.notify_all();
    }
}
fn retire_ready(task: &Task) -> bool {
    task.retire_requested
        && !task.running
        && task.cancellation.is_none()
        && (task.cancellation_confirmed() || task.entered() || !task.cancelled())
        && (task.entered() || task.video_transaction.is_none())
}
struct CancellationOwner {
    id: String,
    flight: Option<Arc<CancellationFlight>>,
}
impl CancellationOwner {
    fn complete(&mut self, outcome: Result<(), String>) {
        let Some(flight) = self.flight.take() else {
            return;
        };
        if let Ok(mut state) = TASK.lock() {
            if let Some(task) = state.as_mut().filter(|task| {
                task.id == self.id
                    && task
                        .cancellation
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, &flight))
            }) {
                if outcome.is_ok() {
                    task.cancel_phase = CancelPhase::Confirmed;
                }
                task.cancellation = None;
                if retire_ready(task) {
                    *state = None;
                }
            }
        }
        flight.complete(outcome);
    }
}
impl Drop for CancellationOwner {
    fn drop(&mut self) {
        self.complete(Err("取消未完成，请重试。".into()));
    }
}
enum CancellationClaim {
    Complete,
    Running(Arc<CancellationFlight>),
    Start(Arc<CancellationFlight>),
}
fn claim_cancellation(id: &str) -> Result<CancellationClaim, String> {
    let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
    let task = state
        .as_mut()
        .filter(|task| task.id == id)
        .ok_or("本次准备任务不可用。")?;
    if let Some(flight) = &task.cancellation {
        return Ok(CancellationClaim::Running(flight.clone()));
    }
    if task.entered() {
        return Err("工作台已打开，请选择结束本次制作。".into());
    }
    if task.cancellation_confirmed() && task.video_transaction.is_none() {
        return Ok(CancellationClaim::Complete);
    }
    task.cancel_phase = CancelPhase::Requested;
    let flight = Arc::new(CancellationFlight::default());
    task.cancellation = Some(flight.clone());
    Ok(CancellationClaim::Start(flight))
}
fn mark_run_finished(id: &str) {
    if let Ok(mut state) = TASK.lock() {
        if let Some(task) = state.as_mut().filter(|task| task.id == id) {
            task.running = false;
            if let Some(flight) = &task.cancellation {
                flight.run_finished.notify_all();
            }
            if retire_ready(task) {
                *state = None;
            }
        }
    }
}
// Only the in-flight OBS ensure request is cancellable; cleanup requests must finish.
static OBS_REQUEST: Mutex<Option<(String, TcpStream)>> = Mutex::new(None);

fn snapshot() -> Result<Option<Task>, String> {
    TASK.lock()
        .map(|v| v.clone())
        .map_err(|_| "准备状态不可用。".into())
}
fn update(id: &str, f: impl FnOnce(&mut Task)) {
    if let Ok(mut task) = TASK.lock() {
        if let Some(task) = task.as_mut().filter(|t| t.id == id) {
            f(task);
        }
    }
}
// IDs derive from this owner's actual task and retry, never from wall-clock proximity.
fn diagnostic_identity(id: &str, attempt: u64, step: &str) -> String {
    let digest = Sha256::digest(format!("mizar-preparation:{id}:{attempt}:{step}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
fn diagnostic(app: &tauri::AppHandle, id: &str, step: &str, outcome: &str, evidence: Value) {
    let Some(task) = snapshot().ok().flatten().filter(|task| task.id == id) else {
        return;
    };
    let attempt = diagnostic_identity(id, task.attempt, "attempt");
    let operation = if step == "preparation" {
        id.to_owned()
    } else {
        diagnostic_identity(id, task.attempt, step)
    };
    let log = app.state::<DesktopLog>();
    log.with_task_attempt(
        Some(id),
        Some(&operation),
        (step != "preparation").then_some(id),
        Some(&attempt),
        Some("user"),
        || {
            log.event(
                "preparation_task",
                outcome,
                Some(&json!({"step":step,"attempt":task.attempt,"details":evidence}).to_string()),
            );
        },
    );
}
fn diagnostic_result(app: &tauri::AppHandle, id: &str, step: &str, result: &Result<(), String>) {
    diagnostic(
        app,
        id,
        step,
        if result.is_ok() { "success" } else { "failure" },
        match result {
            Ok(()) => Value::Null,
            Err(cause) => json!({"cause":cause}),
        },
    );
}
fn publish(app: &tauri::AppHandle, id: &str, message: String) {
    if !snapshot().ok().flatten().is_some_and(|task| task.id == id) {
        return;
    }
    let changed = snapshot()
        .ok()
        .flatten()
        .is_some_and(|task| task.message != message);
    update(id, |t| t.message = message.clone());
    if changed {
        diagnostic(app, id, "status", "changed", json!({"message":message}));
    }
    if let Ok(mut status) = app.state::<HostState>().entry_message.lock() {
        *status = message.clone();
    }
}
fn check(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let t = snapshot()?
        .filter(|t| t.id == id && !t.cancelled())
        .ok_or("准备已取消。")?;
    preparation_gate::check_preparation(app, Some(id))?;
    app.state::<production_exit::ExitGate>()
        .check_ticket(preparation_gate::preparation_ticket(app, id)?)?;
    let production = request(app, "GET", "/local/v1/production", json!({}))?;
    let production = crate::lifecycle_contract::production_view(&production)?;
    let valid = if t.entered() {
        (production.mode == "live" || production.mode == "hidden") && entered(app, id)?
    } else {
        production.mode == "preparation" && production.revision == t.revision
    };
    if !valid {
        return Err("制作状态已变化，请重试。".into());
    }
    Ok(())
}
fn entered(app: &tauri::AppHandle, id: &str) -> Result<bool, String> {
    let status = request(
        app,
        "GET",
        &format!("/local/v1/preparation-status?preparationId={id}"),
        json!({}),
    )?;
    crate::lifecycle_contract::cancellation_entered(&status)
}
fn request(app: &tauri::AppHandle, method: &str, path: &str, body: Value) -> Result<Value, String> {
    let (status, value) = production_exit::request_with_identity(
        &app.state::<DesktopLog>(),
        method,
        path,
        &body.to_string(),
        Instant::now() + Duration::from_secs(40),
        None,
    )?;
    if !(200..300).contains(&status) {
        return Err(value["message"]
            .as_str()
            .unwrap_or("自动准备未完成，请重试。")
            .into());
    }
    Ok(value)
}
async fn http(
    app: &tauri::AppHandle,
    method: &'static str,
    path: &'static str,
    body: Value,
) -> Result<Value, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || request(&app, method, path, body))
        .await
        .map_err(|_| "准备请求未完成。".to_string())?
}
async fn restore_video(
    app: &tauri::AppHandle,
    id: &str,
    cancellation_confirmed: bool,
) -> Result<(), String> {
    let transaction = {
        let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
        state
            .as_mut()
            .filter(|task| {
                task.id == id
                    && !task.entered()
                    && (cancellation_confirmed
                        || task.cancellation_confirmed()
                        || (!task.cancelled() && task.entry_phase == EntryPhase::Preparing))
            })
            .and_then(|task| task.video_transaction.take())
    };
    if let Some(transaction) = transaction {
        if let Err(error) = http(
            app,
            "POST",
            "/operator/obs/video-restore",
            json!({"transactionId": transaction}),
        )
        .await
        {
            update(id, |task| {
                if task.video_transaction.is_none() {
                    task.video_transaction = Some(transaction);
                }
            });
            return Err(error);
        }
        update(id, |task| {
            task.obs = false;
            task.capture = false;
        });
    }
    Ok(())
}
// Explicit OBS preparation composes independent visual/audio deadlines. The
// native transport must outlive their settlement, not reintroduce one shared
// 40s veto. Known RPC phases total 198s: 30s visual + 30s setup, two
// 49s audio configuration/cleanup phases, 12s final visual check, and seven
// 4s reads/checks. The remaining 42s covers music preparation, native evidence
// and local/transport overhead. This is not a bound on arbitrary local stalls.
// Other requests keep their existing budget; cancellation still shuts
// down OBS_REQUEST immediately. This is a hard transport cap, not extra OBS
// write authority or permission to accept unverified preparation.
const OBS_ENSURE_REQUEST_SECONDS: u64 = 240;
fn controlled_request_timeout(path: &str) -> Duration {
    Duration::from_secs(if path == "/operator/obs/ensure" {
        OBS_ENSURE_REQUEST_SECONDS
    } else {
        40
    })
}

async fn controlled_post(
    app: &tauri::AppHandle,
    id: &str,
    path: &'static str,
    body: Value,
) -> Result<Value, String> {
    let app = app.clone();
    let id = id.to_owned();
    let body = body.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let result = production_exit::request_with_stream(
            &app.state::<DesktopLog>(),
            "POST",
            path,
            &body,
            Instant::now() + controlled_request_timeout(path),
            None,
            |stream| {
                let mut active = OBS_REQUEST.lock().map_err(|_| "准备状态不可用。")?;
                if !snapshot()?.is_some_and(|task| task.id == id && !task.cancelled()) {
                    return Err("准备已取消。".into());
                }
                *active = Some((
                    id.clone(),
                    stream.try_clone().map_err(|_| "准备连接不可用。")?,
                ));
                Ok(())
            },
        );
        if let Ok(mut active) = OBS_REQUEST.lock() {
            if active.as_ref().is_some_and(|(saved, _)| saved == &id) {
                *active = None;
            }
        }
        let (status, value) = result?;
        if !(200..300).contains(&status) {
            return Err(value["message"]
                .as_str()
                .unwrap_or("OBS 自动准备未完成。")
                .into());
        }
        if path == "/operator/production"
            && crate::lifecycle_contract::production_view(&value)?.mode != "live"
        {
            return Err("制作进入状态未确认。".into());
        }
        Ok(value)
    })
    .await
    .map_err(|_| "准备请求未完成。".to_string())?
}
fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "准备中心窗口不可用。".into())
}
fn current_revision(app: &tauri::AppHandle) -> Result<String, String> {
    let value = request(app, "GET", "/local/v1/production", json!({}))?;
    Ok(crate::lifecycle_contract::production_view(&value)?.revision)
}
async fn prepare_obs(
    app: tauri::AppHandle,
    id: String,
    task: Task,
    revision: String,
) -> Result<(), String> {
    diagnostic(&app, &id, "obs", "begin", Value::Null);
    let result: Result<(), String> = async {
        check(&app, &id)?;
        let mut obs = http(&app, "GET", "/local/v1/obs", json!({})).await?;
        if task.obs && preparation_evidence::obs_current(&obs) {
            return check(&app, &id);
        }
        update(&id, |t| {
            t.obs = false;
            t.capture = false;
        });
        if obs["connection"] != "connected" {
            if obs["connection"] == "password_required" || obs["connection"] == "invalid_password" {
                return Err("OBS WebSocket 密码未配置或不正确。".into());
            }
            let target = http(&app, "POST", "/operator/obs/launch-target", json!({})).await?;
            let path = target["executablePath"]
                .as_str()
                .ok_or("未找到 OBS 可执行文件。")?
                .to_owned();
            crate::obs_configuration::launch_managed(
                path,
                app.state::<DesktopLog>().inner().clone(),
                Some(diagnostic_identity(&id, task.attempt, "obs")),
            )
            .await?;
        }
        // OBS accepts WebSocket connections before its output requests are ready.
        for _ in 0..30 {
            if obs["connection"] == "connected"
                && obs["streaming"].is_boolean()
                && obs["recording"].is_boolean()
            {
                break;
            }
            check(&app, &id)?;
            tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_secs(1)))
                .await
                .map_err(|_| "OBS 等待失败。")?;
            obs = http(&app, "GET", "/local/v1/obs", json!({})).await?;
        }
        if obs["connection"] != "connected" {
            return Err("OBS 未能连接，请检查后重试。".into());
        }
        if task.obs_owned && preparation_evidence::obs_taken_over(&obs) {
            return Err("OBS 场景已由操作者接管，未自动切换。".into());
        }
        let outputs = http(&app, "GET", "/local/v1/obs/outputs", json!({})).await?;
        let observing = ["stream", "record"].iter().any(|kind| {
            let output = &outputs[*kind];
            output["active"] == true
                || matches!(
                    output["phase"].as_str(),
                    Some("starting" | "stopping" | "reconnecting" | "paused")
                )
        });
        if observing {
            // An existing output is observed, never reinitialized or switched by preparation.
            let checked = http(&app, "POST", "/operator/obs/check", json!({})).await?;
            if let Some(finding) = checked["blockingFindings"]
                .as_array()
                .and_then(|items| items.first())
            {
                return Err(finding["message"]
                    .as_str()
                    .unwrap_or("OBS 当前配置尚未确认，请在 OBS 核对。")
                    .to_string());
            }
            return check(&app, &id);
        }
        http(
            &app,
            "POST",
            "/operator/obs/video-preflight",
            json!({"expectedRevision":revision}),
        )
        .await?;
        let video = http(
            &app,
            "POST",
            "/operator/obs/video-prepare",
            json!({"expectedRevision":revision}),
        )
        .await?;
        if let Some(transaction) = video["transactionId"].as_str() {
            update(&id, |t| t.video_transaction = Some(transaction.to_owned()));
        }
        let prepared = async {
            check(&app, &id)?;
            controlled_post(
                &app,
                &id,
                "/operator/obs/ensure",
                json!({"expectedRevision":revision,"preparationId":id}),
            )
            .await?;
            update(&id, |t| t.obs_owned = true);
            let obs = http(&app, "GET", "/local/v1/obs", json!({})).await?;
            if obs["connection"] != "connected" || obs["readiness"]["ready"] != true {
                return Err(obs["readiness"]["reason"]
                    .as_str()
                    .unwrap_or("OBS 准备状态未确认。")
                    .to_string());
            }
            check(&app, &id)
        }
        .await;
        if prepared.is_err() && !task.entered() {
            restore_video(&app, &id, false).await?;
        }
        prepared
    }
    .await;
    diagnostic_result(&app, &id, "obs", &result);
    match result {
        Ok(()) => update(&id, |t| t.obs = true),
        Err(e) => {
            update(&id, |t| {
                t.obs = false;
                t.capture = false;
            });
            return Err(e);
        }
    }
    Ok::<(), String>(())
}

async fn prepare_game(
    app: &tauri::AppHandle,
    id: &str,
    previous: &Task,
    revision: &str,
) -> Result<(), String> {
    let mut task = previous.clone();
    task.revision = revision.to_owned();
    check(&app, id)?;
    let current = crate::cs2_host::preparation_status(app.clone(), id.to_owned()).await?;
    if task.game && !preparation_evidence::game_current(&current, id) {
        // Process cleanup cannot retire a possibly accepted companion camera request.
        // Do not launch a replacement only to strand it behind the previous unknown.
        if !preparation_evidence::restart_allowed(&current, task.camera_uncertain) {
            return Err(
                "原游戏事务、身份或上次运镜请求尚未确认；未启动新的游戏，请结束制作并恢复后重试。"
                    .into(),
            );
        }
        // The owner proved the old process and transaction have ended. Re-enter the
        // existing launch flow, including MulNX qualification, for this same task.
        task.game = false;
        task.external = None;
        update(id, |t| {
            t.game = false;
            t.camera = false;
            t.capture = false;
        });
    }
    let gsi = crate::gsi_host::status(app.state::<DesktopLog>().inner().clone()).await?;
    if task.gsi && !preparation_evidence::gsi_current(&gsi) {
        task.gsi = false;
        update(id, |t| t.gsi = false);
        if current["running"] == true || current["pending"] == true {
            return Err("当前游戏的 GSI 配置已变化，未覆盖运行中配置；请结束并恢复后重试。".into());
        }
    }
    if !task.game {
        check(&app, &id)?;
        let status = crate::cs2_host::status(app.clone()).await?;
        let resuming = status["preparationId"] == id
            && (status["running"] == true
                || status["pending"] == true
                || status["mulnxLaunchResumable"] == true);
        if !resuming {
            let replacement = crate::cs2_host::preflight(app.clone()).await?;
            let target = &replacement["target"];
            if let Some((pid, created)) = &task.external {
                if target["pid"].as_u64() != Some(u64::from(*pid))
                    || target["created"].as_str() != Some(created.as_str())
                {
                    return Err("所选游戏实例已变化，请重试。".into());
                }
            }
            crate::cs2_host::replace(
                app.clone(),
                target["pid"].as_u64().map(|v| v as u32),
                target["created"].as_str().map(str::to_owned),
                task.revision.clone(),
                id.to_owned(),
                Some(diagnostic_identity(&id, task.attempt, "game")),
            )
            .await?;
        }
    } else {
        check(&app, &id)?;
    }
    if !task.gsi {
        diagnostic(&app, &id, "gsi", "begin", Value::Null);
        let result: Result<(), String> = async {
            check(&app, &id)?;
            let status = crate::gsi_host::status(app.state::<DesktopLog>().inner().clone()).await?;
            if status["readFailed"] == true || status["detected"] != true {
                return Err(status["issues"][0]["message"]
                    .as_str()
                    .unwrap_or("无法确认 CS2 安装或 GSI 配置。")
                    .into());
            }
            let result = crate::gsi_host::ensure(
                app.clone(),
                app.state::<DesktopLog>().inner().clone(),
                Some(id.to_owned()),
                Some(diagnostic_identity(&id, task.attempt, "gsi")),
            )
            .await?;
            if !preparation_evidence::gsi_current(&result) {
                return Err("GSI 自动配置未完成。".into());
            }
            check(&app, &id)
        }
        .await;
        diagnostic_result(&app, &id, "gsi", &result);
        match result {
            Ok(()) => update(&id, |t| t.gsi = true),
            Err(e) => return Err(e),
        }
    }
    check(&app, &id)?;
    let mut game = crate::cs2_host::status(app.clone()).await?;
    let mut launched_mulnx = false;
    if game["mulnxLaunchResumable"] == true {
        let receipt = crate::cs2_host::launch_mulnx(
            app.clone(),
            None,
            None,
            Some(true),
            Some(id.to_owned()),
            Some(diagnostic_identity(&id, task.attempt, "game")),
        )
        .await?;
        launched_mulnx = true;
        if receipt["result"] == "not-found" {
            return Err("原启动请求无法确认，请退出后重新准备。".into());
        }
    } else if game["preferMulnx"] == true && game["running"] != true && game["pending"] != true {
        crate::cs2_host::launch_mulnx(
            app.clone(),
            Some(true),
            Some(task.preserve),
            None,
            Some(id.to_owned()),
            Some(diagnostic_identity(&id, task.attempt, "game")),
        )
        .await?;
        launched_mulnx = true;
    }
    game = crate::cs2_host::status(app.clone()).await?;
    if (game["running"] != true && game["pending"] != true) || launched_mulnx {
        crate::cs2_host::start(
            app.clone(),
            Some(task.preserve && !launched_mulnx),
            Some(id.to_owned()),
            Some(diagnostic_identity(&id, task.attempt, "game")),
            Some(id.to_owned()),
            Some("user".into()),
        )
        .await?;
    }
    for _ in 0..60 {
        check(&app, &id)?;
        game = crate::cs2_host::status(app.clone()).await?;
        if game["running"] == true && game["preparationId"] == id {
            break;
        }
        tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_secs(1)))
            .await
            .map_err(|_| "游戏等待失败。")?;
    }
    if game["running"] != true || game["preparationId"] != id {
        return Err("CS2 启动尚未确认，请检查游戏状态后重试。".into());
    }
    Ok::<(), String>(())
}

async fn prepare_camera(
    app: tauri::AppHandle,
    id: String,
    task: Task,
    revision: String,
) -> Result<(), String> {
    check(&app, &id)?;
    let game = crate::cs2_host::status(app.clone()).await?;
    match preparation_evidence::camera_evidence(&game, &id, task.camera_uncertain) {
        preparation_evidence::CameraEvidence::Ready => {
            update(&id, |t| {
                t.camera = true;
                t.camera_uncertain = false;
            });
            return Ok(());
        }
        preparation_evidence::CameraEvidence::Unconfirmed => {
            update(&id, |t| t.camera = false);
            return Err("受管游戏或上次运镜准备结果未确认，请完成恢复后重试。".into());
        }
        preparation_evidence::CameraEvidence::Prepare => update(&id, |t| t.camera = false),
    }
    diagnostic(&app, &id, "camera", "begin", Value::Null);
    let result: Result<(), String> = async {
        check(&app, &id)?;
        update(&id, |t| t.camera_uncertain = true);
        let result =
            crate::cs2_host::begin_camera(app.clone(), revision.clone(), id.clone()).await?;
        if result["state"] != "ready" {
            if result["state"] == "not_started" {
                update(&id, |t| t.camera_uncertain = false);
            }
            return Err(result["message"]
                .as_str()
                .unwrap_or("运镜未准备完成。")
                .into());
        }
        Ok(())
    }
    .await;
    diagnostic_result(&app, &id, "camera", &result);
    if result.is_ok() {
        update(&id, |task| {
            task.camera = true;
            task.camera_uncertain = false;
        });
    }
    result
}

async fn run(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if snapshot()?.is_some_and(|task| task.id == id && task.entry_phase == EntryPhase::Requested)
        && entered(&app, &id)?
    {
        let revision = current_revision(&app)?;
        update(&id, |task| {
            task.entry_phase = EntryPhase::Entered;
            task.revision = revision;
        });
    }
    let task = snapshot()?
        .filter(|t| t.id == id)
        .ok_or("准备任务不存在。")?;
    main_window(&app)?;
    check(&app, &id)?;
    if !task.entered() {
        update(&id, |task| {
            if task.entry_phase == EntryPhase::Preparing {
                task.entry_phase = EntryPhase::Requested;
            }
        });
        diagnostic(&app, &id, "enter", "begin", Value::Null);
        let value = controlled_post(
            &app,
            &id,
            "/operator/production",
            json!({"action":"enter","expectedRevision":task.revision,"preparationId":id}),
        )
        .await?;
        let view = crate::lifecycle_contract::production_view(&value)?;
        update(&id, |t| {
            t.entry_phase = EntryPhase::Entered;
            t.revision = view.revision;
        });
        diagnostic(&app, &id, "enter", "success", Value::Null);
    }
    let task = snapshot()?
        .filter(|t| t.id == id)
        .ok_or("准备任务不存在。")?;
    if task.panel_epoch.is_none() {
        let epoch = crate::workspace_presentation::panels(app.clone(), id.clone()).await?;
        update(&id, |task| {
            task.panel_epoch = task.panel_epoch.max(Some(epoch))
        });
    }
    publish(&app, &id, "正在准备游戏和 OBS，可先填写 GoTV。".into());
    let mut errors = Vec::new();
    let revision = current_revision(&app)?;
    update(&id, |t| t.revision = revision.clone());
    let obs_job = tauri::async_runtime::spawn(prepare_obs(
        app.clone(),
        id.clone(),
        task.clone(),
        revision.clone(),
    ));
    diagnostic(&app, &id, "game", "begin", Value::Null);
    let game_result = prepare_game(&app, &id, &task, &revision).await;
    diagnostic_result(&app, &id, "game", &game_result);
    let game_prepared = game_result.is_ok();
    if game_prepared {
        let followup: Result<(), String> = async {
            update(&id, |t| t.game = true);
            check(&app, &id)?;
            // The game may be used while OBS capture or camera preparation is still pending.
            // Use the latest explicit panel entry, not the snapshot from before
            // game startup. Hidden/reopened windows may have a newer intent.
            if let Some(epoch) = snapshot()?
                .filter(|task| task.id == id)
                .and_then(|task| task.panel_epoch)
            {
                if let Err(error) = crate::workspace_presentation::finish_preparation(
                    app.clone(),
                    id.clone(),
                    epoch,
                )
                .await
                {
                    errors.push(error);
                }
            }
            let connection = http(&app, "GET", "/local/v1/observer-assist", json!({})).await?;
            if connection["mapConnection"].is_object() {
                diagnostic(
                    &app,
                    &id,
                    "connection",
                    "begin",
                    json!({"intentId":connection["mapConnection"]["id"]}),
                );
                let result = crate::observer_workspace::observer_command(
                    main_window(&app)?,
                    app.clone(),
                    "start-configured".into(),
                    None,
                    None,
                    connection["revision"].as_str().map(str::to_owned),
                )
                .await
                .map(|value| {
                    if let Some(warning) = value["warning"].as_str() {
                        errors.push(warning.to_owned());
                    }
                });
                diagnostic_result(&app, &id, "connection", &result);
                if let Err(error) = result {
                    errors.push(error);
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = followup {
            errors.push(error);
        }
    }
    if game_prepared {
        if let Err(error) =
            prepare_camera(app.clone(), id.clone(), task.clone(), revision.clone()).await
        {
            errors.push(error);
        }
    }
    let obs_result = obs_job
        .await
        .map_err(|_| "OBS 准备任务未完成。".to_string())?;
    if let Err(error) = obs_result {
        errors.push(error);
    }
    if let Err(error) = game_result {
        errors.push(error);
    }
    let prepared = snapshot()?
        .filter(|t| t.id == id)
        .ok_or("准备任务不存在。")?;
    let game = crate::cs2_host::status(app.clone()).await?;
    let game_ready = game_prepared && game["running"] == true && game["preparationId"] == id;
    if prepared.obs && game_ready {
        diagnostic(&app, &id, "capture", "begin", Value::Null);
        let result: Result<(), String> = async {
            check(&app, &id)?;
            // Only a completed/released capture may use the read-only shortcut.
            // Incomplete warmup still goes through its owner's recovery transaction.
            if task.capture {
                let since = SystemTime::now().duration_since(UNIX_EPOCH)
                    .map_err(|_| "当前时间不可用，采集证据未确认。")?.as_millis();
                let current = http(&app, "POST", "/operator/obs/capture-initialization",
                    json!({"expectedRevision":revision,"since":since,"transactionId":null})).await?;
                match preparation_evidence::capture_evidence(&current) {
                    preparation_evidence::CaptureEvidence::Ready => return Ok(()),
                    preparation_evidence::CaptureEvidence::Unconfirmed =>
                        return Err("当前 OBS 采集证据未确认，请检查游戏窗口和 OBS 后重试。".into()),
                    preparation_evidence::CaptureEvidence::Warmup => {},
                }
                update(&id, |t| t.capture = false);
            }
            let mut warmup = Value::Null;
            for _ in 0..60 {
                check(&app, &id)?;
                warmup = http(&app, "POST", "/operator/obs/capture-warmup", json!({"expectedRevision":revision,"preparationId":id})).await?;
                if warmup["state"] != "waiting" { break; }
                tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_secs(1))).await.map_err(|_| "游戏窗口等待失败。")?;
            }
            if warmup["state"] == "waiting" {
                return Err(warmup["message"].as_str().unwrap_or("OBS 尚未发现可用的 CS2 窗口，请确认游戏已启动，再重试准备。").to_string());
            }
            let transaction = warmup["transactionId"].as_str().map(str::to_owned);
            if transaction.is_none() && !warmup["transactionId"].is_null() {
                return Err("游戏捕获准备未确认。".into());
            }
            let since = warmup["startedAt"].clone();
            let capture = async {
                let mut message = "OBS 游戏捕获未确认，请检查后重试。";
                for _ in 0..60 {
                    check(&app, &id)?;
                    let state = http(&app, "POST", "/operator/obs/capture-initialization", json!({"expectedRevision":revision,"since":since,"transactionId":transaction})).await?;
                    if state["state"] == "initialized" { return Ok(()); }
                    message = match state["reason"].as_str() {
                        Some("target_unavailable") => "OBS 游戏采集目标不可用，请确认 CS2 窗口已打开，并在停止输出后修复 Mizar 场景，再重试准备。",
                        Some("target_ambiguous") => "OBS 检测到多个 CS2 窗口，请关闭多余游戏窗口，再重试准备。",
                        _ => "OBS 游戏捕获未确认，请检查后重试。",
                    };
                    if state["state"] == "failed" || state["reason"] == "source_inactive" { break; }
                    tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_secs(1))).await.map_err(|_| "捕获等待失败。")?;
                }
                Err(message.to_string())
            }.await;
            let release = if let Some(transaction) = transaction {
                http(&app, "POST", "/operator/obs/capture-warmup-release", json!({"transactionId":transaction})).await
            } else {
                Ok(Value::Null)
            };
            match (capture, release) {
                (Ok(()), Ok(_)) => Ok(()),
                (Err(error), Ok(_)) | (Ok(()), Err(error)) => Err(error),
                (Err(first), Err(second)) if first == second => Err(first),
                (Err(first), Err(second)) => Err(format!("{first} 临时采集仍待清理：{second}")),
            }
        }.await;
        diagnostic_result(&app, &id, "capture", &result);
        match result {
            Ok(()) => update(&id, |t| t.capture = true),
            Err(e) => {
                update(&id, |t| t.capture = false);
                errors.push(e);
            }
        }
    }
    check(&app, &id)?;
    let mut unique = Vec::new();
    for error in errors {
        if !unique.contains(&error) {
            unique.push(error);
        }
    }
    publish(&app, &id, unique.join("；"));
    Ok(())
}
fn spawn(app: tauri::AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        diagnostic(&app, &id, "preparation", "begin", Value::Null);
        let result = run(app.clone(), id.clone()).await;
        if let Err(mut error) = result {
            if let Err(restore) = restore_video(&app, &id, false).await {
                error = format!("{error} OBS 视频设置恢复未确认：{restore}");
            }
            diagnostic(&app, &id, "preparation", "failure", json!({"cause":error}));
            publish(&app, &id, error);
        } else if let Some(task) = snapshot().ok().flatten().filter(|task| task.id == id) {
            diagnostic(
                &app,
                &id,
                "preparation",
                if task.cancelled() {
                    "cancelled"
                } else if task.entered() && task.message.is_empty() {
                    "success"
                } else {
                    "partial"
                },
                json!({"entered":task.entered(),"obs":task.obs,"gsi":task.gsi,"capture":task.capture,"camera":task.camera,"message":task.message}),
            );
        }
        mark_run_finished(&id);
    });
}
fn request_retirement() {
    if let Ok(mut state) = TASK.lock() {
        if let Some(task) = state.as_mut() {
            task.retire_requested = true;
            if retire_ready(task) {
                *state = None;
            }
        }
    }
}
/// A successful native workspace exit retires its preparation owner for every caller.
pub(crate) fn retire_after_exit() {
    request_retirement();
    if let Ok(mut active) = OBS_REQUEST.lock() {
        if let Some((_, stream)) = active.take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}
fn preparation_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    preparation_id: String,
    expected_revision: String,
    preserve_settings: bool,
    external_pid: Option<u32>,
    external_created: Option<String>,
    ticket: u64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在准备中心启动工作台。".into());
    }
    if preparation_id.is_empty()
        || preparation_id.len() > 64
        || !preparation_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("启动事务标识无效。".into());
    }
    let external = match (external_pid, external_created) {
        (Some(pid), Some(created)) => Some((pid, created)),
        (None, None) => None,
        _ => return Err("游戏实例标识不完整。".into()),
    };
    let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
    if let Some(existing) = state.as_mut() {
        if existing.retire_requested || existing.cancellation.is_some() {
            return Err("原准备任务正在收尾，请稍后重试。".into());
        }
        if !existing.cancelled() {
            if existing.revision != expected_revision
                || (existing.preserve != preserve_settings
                    && !(preserve_settings && !existing.entered() && !existing.running))
                || existing.external != external
            {
                return Err("已有准备任务，请重试或取消原任务。".into());
            }
            app.state::<production_exit::ExitGate>()
                .check_ticket(preparation_gate::preparation_ticket(&app, &existing.id)?)?;
            if existing.running {
                return Ok(());
            }
            existing.preserve = preserve_settings;
            existing.running = true;
            existing.attempt = existing.attempt.saturating_add(1);
            let id = existing.id.clone();
            drop(state);
            publish(&app, &id, "正在重试准备…".into());
            spawn(app, id);
            return Ok(());
        }
        if existing.running {
            return Err("原准备任务正在取消，请稍后重试。".into());
        }
        if !existing.cancellation_confirmed() || existing.video_transaction.is_some() {
            return Err("原准备任务取消或恢复未确认，请重试取消。".into());
        }
    }
    *app.state::<HostState>()
        .entry_ticket
        .lock()
        .map_err(|_| "启动状态不可用。")? = Some((preparation_id.clone(), ticket));
    *state = Some(Task {
        id: preparation_id.clone(),
        revision: expected_revision,
        attempt: 1,
        preserve: preserve_settings,
        external,
        running: true,
        cancel_phase: CancelPhase::Active,
        cancellation: None,
        retire_requested: false,
        obs: false,
        obs_owned: false,
        gsi: false,
        game: false,
        capture: false,
        camera: false,
        camera_uncertain: false,
        entry_phase: EntryPhase::Preparing,
        panel_epoch: None,
        video_transaction: None,
        message: "正在准备游戏和 OBS…".into(),
    });
    drop(state);
    spawn(app, preparation_id);
    Ok(())
}
// The authenticated Host sends this only for its active game preparation. The
// Companion checks the same entry identity, revision and cancellation owner.
pub(crate) fn mulnx_context(id: &str) -> Result<Value, String> {
    let task = snapshot()?
        .filter(|task| {
            task.id == id
                && task.entered()
                && task.running
                && !task.game
                && !task.cancelled()
                && !task.retire_requested
        })
        .ok_or("本次游戏准备已失效，请重新打开工作台。")?;
    Ok(json!({"id": task.id, "revision": task.revision}))
}
pub(crate) fn waiting_for_game() -> Result<bool, String> {
    Ok(snapshot()?.is_some_and(|task| {
        task.entered() && task.running && !task.game && !task.cancelled() && !task.retire_requested
    }))
}
pub(crate) fn status() -> Result<Option<PreparationStatus>, String> {
    Ok(snapshot()?.map(|task| PreparationStatus {
        cancelled: task.cancelled(),
        entered: task.entered(),
        id: task.id,
        running: task.running,
        message: task.message,
        steps: PreparationSteps {
            obs: task.obs,
            game_configuration: task.gsi,
            game: task.game,
            capture: task.capture,
            camera: task.camera,
        },
    }))
}
fn preparation_retry(app: tauri::AppHandle, preparation_id: String) -> Result<(), String> {
    let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
    let task = state
        .as_mut()
        .filter(|t| t.id == preparation_id && !t.cancelled() && !t.retire_requested)
        .ok_or("本次准备任务不可用。")?;
    if task.running {
        return Ok(());
    }
    task.running = true;
    task.attempt = task.attempt.saturating_add(1);
    drop(state);
    publish(&app, &preparation_id, "正在重试准备…".into());
    spawn(app, preparation_id);
    Ok(())
}
async fn preparation_cancel(app: tauri::AppHandle, preparation_id: String) -> Result<(), String> {
    let flight = match claim_cancellation(&preparation_id)? {
        CancellationClaim::Complete => return Ok(()),
        CancellationClaim::Running(flight) => flight,
        CancellationClaim::Start(flight) => {
            diagnostic(&app, &preparation_id, "cancel", "begin", Value::Null);
            let job_flight = flight.clone();
            tauri::async_runtime::spawn(async move {
                let mut owner = CancellationOwner {
                    id: preparation_id.clone(),
                    flight: Some(job_flight),
                };
                let outcome: Result<(), String> = async {
                    if let Ok(mut active) = OBS_REQUEST.lock() {
                        if active.as_ref().is_some_and(|(id, _)| id == &preparation_id) {
                            if let Some((_, stream)) = active.take() {
                                let _ = stream.shutdown(std::net::Shutdown::Both);
                            }
                        }
                    }
                    let cancellation = http(
                        &app,
                        "POST",
                        "/operator/preparation-cancel",
                        json!({"preparationId":preparation_id}),
                    )
                    .await;
                    let host = app.clone();
                    let id = preparation_id.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        host.state::<preparation_gate::PreparationGate>().cancel(id)
                    })
                    .await
                    .map_err(|_| "取消准备未完成。")??;
                    match cancellation
                        .and_then(|value| crate::lifecycle_contract::cancellation_entered(&value))
                    {
                        Ok(true) => {
                            update(&preparation_id, |task| {
                                task.entry_phase = EntryPhase::Entered
                            });
                            publish(
                                &app,
                                &preparation_id,
                                "工作台已打开，请选择结束本次制作。".into(),
                            );
                            Err("工作台已打开，请选择结束本次制作。".into())
                        }
                        Ok(false) => {
                            main_window(&app)?;
                            crate::cs2_host::cancel_camera(app.clone()).await?;
                            // Cancellation is acknowledged by the service before restoring: it
                            // fences a delayed enter request for this same preparation ID.
                            restore_video(&app, &preparation_id, true).await?;
                            Ok(())
                        }
                        Err(error) => {
                            publish(
                                &app,
                                &preparation_id,
                                "取消结果未确认，请核对制作状态。".into(),
                            );
                            Err(error)
                        }
                    }
                }
                .await;
                let run_flight = owner.flight.as_ref().expect("cancellation owner").clone();
                let run_id = preparation_id.clone();
                let run_result =
                    tauri::async_runtime::spawn_blocking(move || run_flight.wait_for_run(&run_id))
                        .await
                        .map_err(|_| "准备收尾等待未完成。".to_string())
                        .and_then(|result| result);
                let outcome = match (outcome, run_result) {
                    (Ok(()), Ok(())) => restore_video(&app, &preparation_id, true).await,
                    (Err(error), Ok(())) => Err(error),
                    (Ok(()), Err(error)) => Err(error),
                    (Err(error), Err(wait)) => Err(format!("{error} 准备收尾未确认：{wait}")),
                };
                if outcome.is_ok() {
                    publish(&app, &preparation_id, "准备已取消。".into());
                }
                diagnostic_result(&app, &preparation_id, "cancel", &outcome);
                owner.complete(outcome);
            });
            flight
        }
    };
    tauri::async_runtime::spawn_blocking(move || flight.wait())
        .await
        .map_err(|_| "取消等待未完成。".to_string())?
}

pub(crate) async fn cancel_entry(
    app: tauri::AppHandle,
    entry_id: Option<String>,
) -> Result<(), String> {
    let task = if let Some(id) = &entry_id {
        app.state::<preparation_gate::PreparationGate>()
            .cancel(id.clone())?;
        let (matched, task) = app.state::<EntryIntent>().cancel_with(id, snapshot)?;
        if !matched && task.as_ref().is_some_and(|task| task.id != *id) {
            return Err("准备任务已变化，请重新取消。".into());
        }
        task
    } else {
        snapshot()?
    };
    if let Some(task) = task {
        preparation_cancel(app, task.id).await?;
    } else if entry_id.is_some() {
        let production = http(&app, "GET", "/local/v1/production", json!({})).await?;
        if crate::lifecycle_contract::production_view(&production)?.mode != "preparation" {
            return Err("工作台已打开，请选择结束本次制作。".into());
        }
    }
    Ok(())
}

pub(crate) fn retry_entry(app: tauri::AppHandle) -> Result<(), String> {
    let task = snapshot()?.ok_or("本次准备任务不可用，请重新进入工作台。")?;
    preparation_retry(app, task.id)
}

fn present_entry(
    app: &tauri::AppHandle,
    id: &str,
    ticket: u64,
    expected_url: &str,
) -> Result<(), String> {
    app.state::<preparation_gate::PreparationGate>()
        .commit(Some(id), || {
            crate::workspace_presentation::present_production_inner_checked(
                app,
                true,
                Some((expected_url.to_owned(), id.to_owned())),
                Some(ticket),
            )
        })
}

fn present_existing(
    app: &tauri::AppHandle,
    id: &str,
    ticket: u64,
    expected_url: &str,
    view: &crate::lifecycle_contract::ProductionView,
) -> Result<(), String> {
    if view.mode == "hidden" {
        let resumed = app
            .state::<preparation_gate::PreparationGate>()
            .commit(Some(id), || {
                app.state::<production_exit::ExitGate>().commit(ticket, || {
                    app.state::<EntryIntent>().commit(id, false, || {
                        request(
                            app,
                            "POST",
                            "/operator/production",
                            json!({"action":"enter","expectedRevision":view.revision}),
                        )
                    })
                })
            })?;
        if crate::lifecycle_contract::production_view(&resumed)?.mode != "live" {
            return Err("制作进入状态未确认。".into());
        }
    }
    present_entry(app, id, ticket, expected_url)
}

pub(crate) async fn enter(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    preparation_id: String,
    document: String,
    expected_revision: Option<String>,
    expected_demo_request: Option<String>,
    manual: bool,
    preserve_settings: bool,
    external_pid: Option<u32>,
    external_created: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请在准备中心启动工作台。".into());
    }
    let ticket = app
        .state::<production_exit::ExitGate>()
        .presentation_ticket()?;
    let expected_url = window
        .url()
        .map_err(|_| "准备中心页面不可用。")?
        .to_string();
    crate::entry_intent::begin(
        window.clone(),
        app.clone(),
        preparation_id.clone(),
        document,
    )?;
    let intent_app = app.clone();
    let intent_id = preparation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(async move {
            app.state::<preparation_gate::PreparationGate>()
                .check(Some(&preparation_id))?;
            let mut production = http(&app, "GET", "/local/v1/production", json!({})).await?;
            let mut view = crate::lifecycle_contract::production_view(&production)?;
            let demo = http(&app, "GET", "/local/v1/demo-test", json!({})).await?;
            if demo["active"] == true {
                let request_id = demo["requestId"]
                    .as_str()
                    .ok_or("试播状态未确认，请重试。")?
                    .to_owned();
                if expected_demo_request
                    .as_deref()
                    .is_some_and(|id| id != request_id)
                {
                    return Err("试播状态已变化，请重新进入。".into());
                }
                if external_pid.is_some() || external_created.is_some() {
                    return Err("请先结束 Demo 试播，再选择游戏。".into());
                }
                if let Some(existing) = app
                    .state::<EntryIntent>()
                    .commit(&preparation_id, false, snapshot)?
                    .filter(|task| !task.cancelled())
                {
                    if let Err(error) = preparation_cancel(app.clone(), existing.id.clone()).await {
                        let task_entered = entered(&app, &existing.id)
                            .map_err(|cause| format!("{error} 进入状态复核失败：{cause}"))?;
                        let actual = http(&app, "GET", "/local/v1/production", json!({}))
                            .await
                            .map_err(|cause| format!("{error} 制作状态复核失败：{cause}"))?;
                        let actual_view = crate::lifecycle_contract::production_view(&actual)
                            .map_err(|cause| format!("{error} 制作状态复核失败：{cause}"))?;
                        if task_entered && actual_view.mode != "preparation" {
                            return present_existing(
                                &app,
                                &preparation_id,
                                ticket,
                                &expected_url,
                                &actual_view,
                            );
                        }
                        return Err(error);
                    }
                }
                let result = async {
                    app.state::<preparation_gate::PreparationGate>()
                        .check(Some(&preparation_id))?;
                    let camera = crate::demo_host::enter(
                        window.clone(),
                        app.clone(),
                        request_id.clone(),
                        preparation_id.clone(),
                        ticket,
                        None,
                        None,
                        None,
                    )
                    .await?;
                    app.state::<production_exit::ExitGate>()
                        .check_ticket(ticket)?;
                    crate::workspace_presentation::present_demo(
                        window.clone(),
                        app.clone(),
                        request_id.clone(),
                        expected_url.clone(),
                        preparation_id.clone(),
                        Some(ticket),
                    )
                    .await?;
                    if camera {
                        let state = http(&app, "GET", "/local/v1/demo-test", json!({})).await?;
                        if state["active"] != true
                            || state["phase"] != "playing"
                            || state["requestId"] != request_id
                        {
                            return Err("试播状态已变化，请重新进入。".into());
                        }
                        app.state::<preparation_gate::PreparationGate>().commit(
                            Some(&preparation_id),
                            || {
                                app.state::<production_exit::ExitGate>().commit(ticket, || {
                                    request(
                                        &app,
                                        "POST",
                                        "/operator/orchestration",
                                        json!({"action":"connect"}),
                                    )
                                })
                            },
                        )?;
                    }
                    Ok(())
                }
                .await;
                return result;
            }
            if expected_demo_request.is_some() {
                return Err("试播状态已变化，请重新进入。".into());
            }
            if view.mode != "preparation" {
                if let Some(task) = snapshot()?.filter(|task| {
                    task.entered() && !task.game && !task.cancelled() && !task.retire_requested
                }) {
                    if entered(&app, &task.id)? {
                        if view.mode == "hidden" {
                            request(
                                &app,
                                "POST",
                                "/operator/production",
                                json!({"action":"enter","expectedRevision":view.revision}),
                            )?;
                        }
                        let epoch =
                            crate::workspace_presentation::panels(app.clone(), task.id.clone())
                                .await?;
                        update(&task.id, |task| {
                            task.panel_epoch = task.panel_epoch.max(Some(epoch))
                        });
                        if !task.running {
                            update(&task.id, |task| task.preserve |= preserve_settings);
                            preparation_retry(app, task.id)?;
                        }
                        return Ok(());
                    }
                }
                return present_existing(&app, &preparation_id, ticket, &expected_url, &view);
            }
            if expected_revision
                .as_deref()
                .is_some_and(|revision| revision != view.revision)
            {
                return Err("制作状态已变化，请刷新后重试。".into());
            }
            if manual {
                if let Some(existing) =
                    app.state::<EntryIntent>()
                        .commit(&preparation_id, false, snapshot)?
                {
                    if let Err(error) = preparation_cancel(app.clone(), existing.id.clone()).await {
                        let task_entered = entered(&app, &existing.id)
                            .map_err(|cause| format!("{error} 进入状态复核失败：{cause}"))?;
                        production = http(&app, "GET", "/local/v1/production", json!({}))
                            .await
                            .map_err(|cause| format!("{error} 制作状态复核失败：{cause}"))?;
                        view = crate::lifecycle_contract::production_view(&production)
                            .map_err(|cause| format!("{error} 制作状态复核失败：{cause}"))?;
                        if task_entered && view.mode != "preparation" {
                            return present_existing(
                                &app,
                                &preparation_id,
                                ticket,
                                &expected_url,
                                &view,
                            );
                        }
                        return Err(error);
                    }
                }
                production = http(&app, "GET", "/local/v1/production", json!({})).await?;
                view = crate::lifecycle_contract::production_view(&production)?;
                if view.mode != "preparation" {
                    return present_existing(&app, &preparation_id, ticket, &expected_url, &view);
                }
                if expected_revision
                    .as_deref()
                    .is_some_and(|revision| revision != view.revision)
                {
                    return Err("制作状态已变化，请刷新后重试。".into());
                }
                app.state::<production_exit::ExitGate>()
                    .check_ticket(ticket)?;
                let entered =
                    app.state::<preparation_gate::PreparationGate>().commit(
                        Some(&preparation_id),
                        || {
                            app.state::<production_exit::ExitGate>().commit(ticket, || {
                            app.state::<EntryIntent>().commit(&preparation_id, false, || request(
                                &app,
                                "POST",
                                "/operator/production",
                                json!({"action":"enter","expectedRevision":view.revision}),
                            ))
                        })
                        },
                    )?;
                if crate::lifecycle_contract::production_view(&entered)?.mode != "live" {
                    return Err("制作进入状态未确认。".into());
                }
                return present_entry(&app, &preparation_id, ticket, &expected_url);
            }
            app.state::<preparation_gate::PreparationGate>()
                .commit(Some(&preparation_id), || {
                    app.state::<production_exit::ExitGate>().commit(ticket, || {
                        app.state::<EntryIntent>()
                            .commit(&preparation_id, true, || {
                                preparation_start(
                                    window,
                                    app.clone(),
                                    preparation_id.clone(),
                                    view.revision,
                                    preserve_settings,
                                    external_pid,
                                    external_created,
                                    ticket,
                                )
                            })
                    })
                })
        })
    })
    .await
    .map_err(|_| "进入工作台未完成。".to_string())
    .and_then(|result| result);
    intent_app.state::<EntryIntent>().finish(&intent_id);
    result
}
