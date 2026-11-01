//! The desktop owns preparation independently of any webview lifetime.
use super::*;
use serde_json::{json, Value};

#[derive(Clone)]
struct Task {
    id: String,
    revision: String,
    preserve: bool,
    external: Option<(u32, String)>,
    running: bool,
    cancelled: bool,
    cancellation_confirmed: bool,
    obs: bool,
    obs_owned: bool,
    gsi: bool,
    capture: bool,
    camera: bool,
    camera_uncertain: bool,
    entered: bool,
    enter_attempted: bool,
    presented: bool,
    video_transaction: Option<String>,
    message: String,
}
static TASK: Mutex<Option<Task>> = Mutex::new(None);
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
fn publish(app: &tauri::AppHandle, id: &str, message: String) {
    if !snapshot().ok().flatten().is_some_and(|task| task.id == id) {
        return;
    }
    update(id, |t| t.message = message.clone());
    if let Ok(mut status) = app.state::<HostState>().entry_message.lock() {
        *status = message.clone();
    }
    if let Some(window) = app.get_webview_window("workspace-dock") {
        if let Ok(data) = serde_json::to_string(&message) {
            let _ = window.eval(&format!(
                "window.dispatchEvent(new CustomEvent('mizar-entry-status', {{detail: {data}}}))"
            ));
        }
    }
}
fn check(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let t = snapshot()?
        .filter(|t| t.id == id && !t.cancelled)
        .ok_or("准备已取消。")?;
    check_preparation(app, Some(id))?;
    app.state::<production_exit::ExitGate>()
        .check_ticket(preparation_ticket(app, id)?)?;
    let production = request(app, "GET", "/local/v1/production", json!({}))?;
    let production = crate::lifecycle_contract::production_view(&production)?;
    let valid = if t.entered {
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
                    && !task.entered
                    && (cancellation_confirmed
                        || task.cancellation_confirmed
                        || (!task.cancelled && !task.enter_attempted))
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
    }
    Ok(())
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
            Instant::now() + Duration::from_secs(40),
            None,
            |stream| {
                let mut active = OBS_REQUEST.lock().map_err(|_| "准备状态不可用。")?;
                if !snapshot()?.is_some_and(|task| task.id == id && !task.cancelled) {
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
async fn run(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if snapshot()?.is_some_and(|task| task.id == id && task.enter_attempted && !task.entered)
        && entered(&app, &id)?
    {
        update(&id, |task| task.entered = true);
    }
    let task = snapshot()?
        .filter(|t| t.id == id)
        .ok_or("准备任务不存在。")?;
    let window = main_window(&app)?;
    if !task.entered {
        present_workbench_panels(app.clone(), id.clone()).await?;
        publish(&app, &id, "正在准备游戏和 OBS…".into());
        check(&app, &id)?;
        let status = cs2_config_status(app.clone()).await?;
        let resuming = status["preparationId"] == id
            && (status["running"] == true
                || status["pending"] == true
                || status["mulnxLaunchResumable"] == true);
        if !resuming {
            let replacement = preflight_cs2_replacement(window.clone(), app.clone()).await?;
            let target = &replacement["target"];
            if let Some((pid, created)) = &task.external {
                if target["pid"].as_u64() != Some(u64::from(*pid))
                    || target["created"].as_str() != Some(created.as_str())
                {
                    return Err("所选游戏实例已变化，请重试。".into());
                }
            }
            replace_external_cs2(
                window.clone(),
                app.clone(),
                target["pid"].as_u64().map(|v| v as u32),
                target["created"].as_str().map(str::to_owned),
                task.revision.clone(),
                id.clone(),
                None,
            )
            .await?;
        }
    } else {
        check(&app, &id)?;
        let game = cs2_config_status(app.clone()).await?;
        if game["preparationId"] != id || game["running"] != true {
            return Err("本次游戏尚未确认，请检查后重试。".into());
        }
    }
    let mut errors = Vec::new();
    let revision = current_revision(&app)?;
    if !task.obs {
        let result: Result<(), String> = async {
            check(&app, &id)?;
            let mut obs = http(&app, "GET", "/local/v1/obs", json!({})).await?;
            if task.obs_owned && obs["connection"] == "connected" && obs["sceneAligned"] == false {
                return Err("OBS 场景已由操作者接管，未自动切换。".into());
            }
            if obs["connection"] != "connected" {
                if obs["connection"] == "password_required"
                    || obs["connection"] == "invalid_password"
                {
                    return Err("OBS WebSocket 密码未配置或不正确。".into());
                }
                let target = http(&app, "POST", "/operator/obs/launch-target", json!({})).await?;
                let path = target["executablePath"]
                    .as_str()
                    .ok_or("未找到 OBS 可执行文件。")?
                    .to_owned();
                launch_obs(path, app.state::<DesktopLog>(), None).await?;
                for _ in 0..30 {
                    check(&app, &id)?;
                    tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_secs(1)))
                        .await
                        .map_err(|_| "OBS 等待失败。")?;
                    obs = http(&app, "GET", "/local/v1/obs", json!({})).await?;
                    if obs["connection"] == "connected" {
                        break;
                    }
                }
                if obs["connection"] != "connected" {
                    return Err("OBS 未能连接，请检查后重试。".into());
                }
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
            if prepared.is_err() && !task.entered {
                restore_video(&app, &id, false).await?;
            }
            prepared
        }
        .await;
        match result {
            Ok(()) => update(&id, |t| t.obs = true),
            Err(e) => errors.push(e),
        }
    }
    if !task.gsi {
        let result: Result<(), String> = async {
            check(&app, &id)?;
            let status = gsi_status(app.state::<DesktopLog>()).await?;
            if status["readFailed"] == true || status["detected"] != true {
                return Err(status["issues"][0]["message"]
                    .as_str()
                    .unwrap_or("无法确认 CS2 安装或 GSI 配置。")
                    .into());
            }
            let result = ensure_gsi(
                app.clone(),
                app.state::<DesktopLog>(),
                Some(id.clone()),
                None,
            )
            .await?;
            if result["installed"] != true
                || result["conflict"] == true
                || result["readFailed"] == true
            {
                return Err("GSI 自动配置未完成。".into());
            }
            check(&app, &id)
        }
        .await;
        match result {
            Ok(()) => update(&id, |t| t.gsi = true),
            Err(e) => errors.push(e),
        }
    }
    check(&app, &id)?;
    let mut game = cs2_config_status(app.clone()).await?;
    let mut launched_mulnx = false;
    if game["mulnxLaunchResumable"] == true {
        let receipt = launch_mulnx(
            window.clone(),
            app.clone(),
            None,
            None,
            Some(true),
            Some(id.clone()),
            None,
        )
        .await?;
        launched_mulnx = true;
        if receipt["result"] == "not-found" {
            return Err("原启动请求无法确认，请退出后重新准备。".into());
        }
    } else if game["preferMulnx"] == true && game["running"] != true && game["pending"] != true {
        launch_mulnx(
            window.clone(),
            app.clone(),
            Some(true),
            Some(task.preserve),
            None,
            Some(id.clone()),
            None,
        )
        .await?;
        launched_mulnx = true;
    }
    game = cs2_config_status(app.clone()).await?;
    if (game["running"] != true && game["pending"] != true) || launched_mulnx {
        start_managed_cs2(
            app.clone(),
            Some(task.preserve && !launched_mulnx),
            Some(id.clone()),
            None,
            None,
            None,
        )
        .await?;
    }
    for _ in 0..60 {
        check(&app, &id)?;
        game = cs2_config_status(app.clone()).await?;
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
    if !task.capture {
        let result: Result<(), String> = async {
            check(&app, &id)?;
            let warmup = http(&app, "POST", "/operator/obs/capture-warmup", json!({"expectedRevision":revision,"preparationId":id})).await?;
            let transaction = warmup["transactionId"].as_str().ok_or("游戏捕获准备未确认。")?.to_owned();
            let since = warmup["startedAt"].clone();
            let capture = async {
                for _ in 0..60 {
                    check(&app, &id)?;
                    let state = http(&app, "POST", "/operator/obs/capture-initialization", json!({"expectedRevision":revision,"since":since,"transactionId":transaction})).await?;
                    if state["state"] == "initialized" { return Ok(()); }
                    if state["state"] == "failed" || state["reason"] == "source_inactive" { break; }
                    tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_secs(1))).await.map_err(|_| "捕获等待失败。")?;
                }
                Err("OBS 游戏捕获未确认，请检查后重试。".to_string())
            }.await;
            let release = http(&app, "POST", "/operator/obs/capture-warmup-release", json!({"transactionId":transaction})).await;
            match (capture, release) {
                (Ok(()), Ok(_)) => Ok(()),
                (Err(error), Ok(_)) | (Ok(()), Err(error)) => Err(error),
                (Err(first), Err(second)) => Err(format!("{first} 临时捕获来源清理未确认：{second}")),
            }
        }.await;
        match result {
            Ok(()) => update(&id, |t| t.capture = true),
            Err(e) => errors.push(e),
        }
    }
    if !task.camera {
        let result: Result<(), String> = async {
            check(&app, &id)?;
            if task.camera_uncertain {
                let game = cs2_config_status(app.clone()).await?;
                if game["cameraLeaseReady"] == true && game["preparationId"] == id {
                    return Ok(());
                }
                return Err("上次运镜准备结果未确认，请退出并恢复后重试。".into());
            }
            update(&id, |t| t.camera_uncertain = true);
            let result =
                begin_managed_camera(window.clone(), app.clone(), revision.clone(), id.clone())
                    .await?;
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
        match result {
            Ok(()) => update(&id, |t| {
                t.camera = true;
                t.camera_uncertain = false;
            }),
            Err(e) => errors.push(e),
        }
    }
    check(&app, &id)?;
    if !task.entered {
        // Until the service confirms the outcome, never roll back resources:
        // the enter request may have committed even if its response was lost.
        update(&id, |t| t.enter_attempted = true);
        controlled_post(
            &app,
            &id,
            "/operator/production",
            json!({"action":"enter","expectedRevision":revision,"preparationId":id}),
        )
        .await?;
        update(&id, |t| t.entered = true);
    }
    if !task.presented {
        present_production(app.clone(), true, Some(id.clone()), None, None, None).await?;
        update(&id, |t| t.presented = true);
    }
    publish(&app, &id, errors.join("；"));
    Ok(())
}
fn spawn(app: tauri::AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        let result = run(app.clone(), id.clone()).await;
        if let Err(mut error) = result {
            if let Err(restore) = restore_video(&app, &id, false).await {
                error = format!("{error} OBS 视频设置恢复未确认：{restore}");
            }
            publish(&app, &id, error);
        }
        update(&id, |t| t.running = false);
    });
}
/// A successful native workspace exit retires its preparation owner for every caller.
pub(crate) fn retire_after_exit() {
    if let Ok(mut state) = TASK.lock() {
        *state = None;
    }
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
        if !existing.cancelled {
            if existing.revision != expected_revision
                || (existing.preserve != preserve_settings
                    && !(preserve_settings && !existing.entered && !existing.running))
                || existing.external != external
            {
                return Err("已有准备任务，请重试或取消原任务。".into());
            }
            app.state::<production_exit::ExitGate>()
                .check_ticket(preparation_ticket(&app, &existing.id)?)?;
            if existing.running {
                return Ok(());
            }
            existing.preserve = preserve_settings;
            existing.running = true;
            let id = existing.id.clone();
            drop(state);
            publish(&app, &id, "正在重试准备…".into());
            spawn(app, id);
            return Ok(());
        }
        if existing.running {
            return Err("原准备任务正在取消，请稍后重试。".into());
        }
        if !existing.cancellation_confirmed {
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
        preserve: preserve_settings,
        external,
        running: true,
        cancelled: false,
        cancellation_confirmed: false,
        obs: false,
        obs_owned: false,
        gsi: false,
        capture: false,
        camera: false,
        camera_uncertain: false,
        entered: false,
        enter_attempted: false,
        presented: false,
        video_transaction: None,
        message: "正在准备游戏和 OBS…".into(),
    });
    drop(state);
    spawn(app, preparation_id);
    Ok(())
}
#[tauri::command]
pub(crate) fn preparation_status() -> Result<Value, String> {
    Ok(snapshot()?.map(|t| json!({"id":t.id,"running":t.running,"cancelled":t.cancelled,"entered":t.entered,"message":t.message})).unwrap_or(Value::Null))
}
fn preparation_retry(app: tauri::AppHandle, preparation_id: String) -> Result<(), String> {
    let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
    let task = state
        .as_mut()
        .filter(|t| t.id == preparation_id && !t.cancelled)
        .ok_or("本次准备任务不可用。")?;
    if task.running {
        return Ok(());
    }
    task.running = true;
    drop(state);
    publish(&app, &preparation_id, "正在重试准备…".into());
    spawn(app, preparation_id);
    Ok(())
}
async fn preparation_cancel(app: tauri::AppHandle, preparation_id: String) -> Result<(), String> {
    {
        let mut state = TASK.lock().map_err(|_| "准备状态不可用。")?;
        let task = state
            .as_mut()
            .filter(|t| t.id == preparation_id)
            .ok_or("本次准备任务不可用。")?;
        task.cancelled = true;
    }
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
    match cancellation.and_then(|value| crate::lifecycle_contract::cancellation_entered(&value)) {
        Ok(true) => {
            update(&preparation_id, |task| task.entered = true);
            publish(&app, &preparation_id, "制作已进入，请退出工作台。".into());
            Err("制作已进入，请退出工作台。".into())
        }
        Ok(false) => {
            let window = main_window(&app)?;
            cancel_managed_camera(window, app.clone()).await?;
            // Cancellation is acknowledged by the service before restoring: it
            // fences a delayed enter request for this same preparation ID.
            restore_video(&app, &preparation_id, true).await?;
            update(&preparation_id, |task| task.cancellation_confirmed = true);
            publish(&app, &preparation_id, "准备已取消。".into());
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

#[tauri::command]
pub(crate) async fn cancel_workspace_entry(
    app: tauri::AppHandle,
    entry_id: Option<String>,
) -> Result<(), String> {
    if let Some(id) = &entry_id {
        app.state::<preparation_gate::PreparationGate>()
            .cancel(id.clone())?;
        app.state::<EntryIntent>().cancel(id)?;
    }
    if let Some(task) = snapshot()? {
        preparation_cancel(app, task.id).await?;
    } else if entry_id.is_some() {
        let production = http(&app, "GET", "/local/v1/production", json!({})).await?;
        if crate::lifecycle_contract::production_view(&production)?.mode != "preparation" {
            return Err("制作已进入，请退出工作台。".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn retry_workspace_entry(app: tauri::AppHandle) -> Result<(), String> {
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
            present_production_inner_checked(
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

#[tauri::command]
pub(crate) async fn enter_workspace(
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
    begin_entry(
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
                if let Some(existing) = snapshot()?.filter(|task| !task.cancelled) {
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
                    let camera = enter_demo_test(
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
                    present_demo_test(
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
                return present_existing(&app, &preparation_id, ticket, &expected_url, &view);
            }
            if expected_revision
                .as_deref()
                .is_some_and(|revision| revision != view.revision)
            {
                return Err("制作状态已变化，请刷新后重试。".into());
            }
            if manual {
                if let Some(existing) = snapshot()? {
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
