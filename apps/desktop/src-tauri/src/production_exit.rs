//! Host exit and managed CS2 cleanup preserve Companion production safety boundaries.
use crate::startup_log::DesktopLog;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
#[derive(Clone, Default)]
pub struct WorkspaceExitStatus {
    pub busy: bool,
    pub stage: String,
    pub message: Option<String>,
}
#[derive(Default)]
pub struct WorkspaceExit(std::sync::Mutex<WorkspaceExitStatus>);
impl WorkspaceExit {
    pub fn status(&self) -> WorkspaceExitStatus {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn stage(&self, stage: &str) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = WorkspaceExitStatus {
            busy: true,
            stage: stage.into(),
            message: None,
        };
    }
    pub fn complete(&self, result: &Result<(), String>) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.busy = false;
        state.message = result.as_ref().err().cloned();
        if result.is_ok() {
            state.stage.clear();
        }
    }
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

fn io_failure(log: &DesktopLog, phase: &str, error: &std::io::Error, summary: &str) -> String {
    log.event(
        "production_finish",
        "failure",
        Some(&format!(
            "phase={phase}; os_code={:?}; cause={error:?}",
            error.raw_os_error()
        )),
    );
    summary.into()
}
fn request(
    log: &DesktopLog,
    method: &str,
    path: &str,
    body: &str,
    deadline: Instant,
) -> Result<(u16, serde_json::Value), String> {
    request_with_identity(log, method, path, body, deadline, None)
}

fn wire_request(method: &str, path: &str, body: &str, token: Option<&str>) -> String {
    let identity = match token {
        Some(token) => format!("x-runtime-token: {token}\r\n"),
        None => "Origin: http://127.0.0.1:3000\r\n".into(),
    };
    format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n{identity}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

fn request_failure(token: Option<&str>, production_summary: &'static str) -> &'static str {
    if token.is_some() {
        "本场回收资格请求未完成。请重试；再次失败时查看诊断。"
    } else {
        production_summary
    }
}

pub(crate) fn request_with_identity(
    log: &DesktopLog,
    method: &str,
    path: &str,
    body: &str,
    deadline: Instant,
    token: Option<&str>,
) -> Result<(u16, serde_json::Value), String> {
    request_with_stream(log, method, path, body, deadline, token, |_| Ok(()))
}

pub(crate) fn request_with_stream(
    log: &DesktopLog,
    method: &str,
    path: &str,
    body: &str,
    deadline: Instant,
    token: Option<&str>,
    connected: impl FnOnce(&TcpStream) -> Result<(), String>,
) -> Result<(u16, serde_json::Value), String> {
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .ok_or(request_failure(token, "制作收尾超时，请重试。"))?;
    let address: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let mut stream = TcpStream::connect_timeout(&address, timeout.min(Duration::from_secs(1)))
        .map_err(|error| {
            io_failure(
                log,
                "tcp_connect",
                &error,
                request_failure(token, "无法连接制作服务，游戏与备份仍保留。"),
            )
        })?;
    connected(&stream)?;
    stream.set_write_timeout(Some(timeout)).map_err(|error| {
        io_failure(
            log,
            "tcp_write_timeout",
            &error,
            request_failure(
                token,
                "收尾请求通信设置失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
            ),
        )
    })?;
    stream
        .write_all(wire_request(method, path, body, token).as_bytes())
        .map_err(|error| {
            io_failure(
                log,
                "tcp_write",
                &error,
                request_failure(
                    token,
                    "收尾请求发送失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
                ),
            )
        })?;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(request_failure(token, "制作收尾超时，请重试。"))?;
        stream.set_read_timeout(Some(remaining)).map_err(|error| {
            io_failure(
                log,
                "tcp_read_timeout",
                &error,
                request_failure(
                    token,
                    "收尾请求通信设置失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
                ),
            )
        })?;
        let mut buffer = [0; 4096];
        let count = stream.read(&mut buffer).map_err(|error| {
            io_failure(
                log,
                "tcp_read",
                &error,
                request_failure(
                    token,
                    "收尾服务响应读取失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
                ),
            )
        })?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 64 * 1024 {
            return Err(request_failure(
                token,
                "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。",
            )
            .into());
        }
    }
    let response = std::str::from_utf8(&bytes).map_err(|error| {
        log.event(
            "production_finish",
            "failure",
            Some(&format!("phase=response_utf8; cause={error}")),
        );
        request_failure(
            token,
            "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。",
        )
    })?;
    let (headers, payload) = response.split_once("\r\n\r\n").ok_or(request_failure(
        token,
        "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。",
    ))?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or(request_failure(
            token,
            "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。",
        ))?;
    // Fastify's JSON responses have Content-Length. Fail closed on other framing.
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        return Err(request_failure(token, "制作收尾响应格式不支持。").into());
    }
    let value = serde_json::from_str(payload).map_err(|error: serde_json::Error| {
        log.event(
            "production_finish",
            "failure",
            Some(&format!(
                "phase=response_json; category={:?}; line={}; column={}",
                error.classify(),
                error.line(),
                error.column()
            )),
        );
        request_failure(
            token,
            "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。",
        )
    })?;
    Ok((status, value))
}
const EXIT_ENDPOINT: &str = "/operator/runtime/local-match-exit";
const EXIT_UNCONFIRMED: &str =
    "收尾已执行，但游戏退出和本场回收资格未确认。请重试结束游戏；再次失败时查看诊断。";

pub(crate) fn runtime_token(log: &DesktopLog) -> Result<String, String> {
    let failure = "本地服务身份校验失败。请重新打开 Mizar；再次失败时查看诊断。";
    let file = std::fs::File::open(log.state_root.join("data/runtime.json"))
        .map_err(|error| io_failure(log, "runtime_read", &error, failure))?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_failure(log, "runtime_read", &error, failure))?;
    if bytes.len() > 64 * 1024 {
        log.event(
            "production_finish",
            "failure",
            Some("phase=runtime_read; size_limit_exceeded"),
        );
        return Err(failure.into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        // Never format JSON errors with input values or include the private state.
        log.event(
            "production_finish",
            "failure",
            Some(&format!(
                "phase=runtime_json; category={:?}; line={}; column={}",
                error.classify(),
                error.line(),
                error.column()
            )),
        );
        failure
    })?;
    value["controlToken"]
        .as_str()
        .filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_owned)
        .ok_or_else(|| {
            log.event(
                "production_finish",
                "failure",
                Some("phase=runtime_identity; invalid_token_shape"),
            );
            failure.into()
        })
}

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
        return Err("本场回收资格校验未完成。请重试；再次失败时查看诊断。".into());
    }
    Ok(response)
}

fn prepare_local_match_exit(log: &DesktopLog) -> Result<Option<serde_json::Value>, String> {
    let response = exit_request(log, serde_json::json!({"action": "prepare"}))?;
    match response.get("qualification") {
        Some(serde_json::Value::Null) => Ok(None),
        Some(value)
            if value.as_object().is_some_and(|fields| {
                fields.len() == 3
                    && ["ticket", "matchId", "contextRevision"]
                        .iter()
                        .all(|field| {
                            fields
                                .get(*field)
                                .and_then(serde_json::Value::as_str)
                                .is_some_and(|value| !value.is_empty())
                        })
            }) =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err("本场回收资格响应无效。请重试；再次失败时查看诊断。".into()),
    }
}

fn confirm_local_match_exit(
    log: &DesktopLog,
    qualification: serde_json::Value,
) -> Result<(), String> {
    let response = exit_request(
        log,
        serde_json::json!({"action": "confirm", "qualification": qualification}),
    )?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err("本场回收资格响应无效。请重试；再次失败时查看诊断。".into())
    }
}

fn settle_local_match_exit(
    log: &DesktopLog,
    qualification: &serde_json::Value,
) -> Result<(), String> {
    let response = exit_request(
        log,
        serde_json::json!({"action": "settle", "qualification": qualification}),
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
            "无法撤销上一场退出资格，CS2 尚未启动。请重试；再次失败时查看诊断。".to_string()
        })?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err("无法确认退出资格已撤销，CS2 尚未启动。请重试；再次失败时查看诊断。".into())
    }
}

fn finish_with_qualification(
    prepare: impl FnOnce() -> Result<Option<serde_json::Value>, String>,
    finish: impl FnOnce(bool) -> Result<(), String>,
    settle: impl FnOnce(&serde_json::Value) -> Result<(), String>,
    confirm: impl FnOnce(serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    let qualification = prepare();
    // Cleanup is required even if the private Companion handshake is unavailable.
    finish(matches!(&qualification, Ok(Some(_))))?;
    match qualification {
        Ok(Some(qualification)) => {
            settle(&qualification).map_err(|_| EXIT_UNCONFIRMED.to_string())?;
            confirm(qualification).map_err(|_| EXIT_UNCONFIRMED.into())
        }
        Ok(None) => Ok(()),
        Err(_) => Err(EXIT_UNCONFIRMED.into()),
    }
}

/// Caller holds the managed CS2 mutex across prepare, native cleanup and confirmation.
pub fn finish_managed_game(
    log: &DesktopLog,
    finish: impl FnOnce(bool) -> Result<(), String>,
) -> Result<(), String> {
    finish_with_qualification(
        || prepare_local_match_exit(log),
        finish,
        |qualification| settle_local_match_exit(log, qualification),
        |qualification| confirm_local_match_exit(log, qualification),
    )
}

/// Switching to an external instance is explicit, preparation-only and disconnects old camera intent.
pub fn prepare_external_entry(log: &DesktopLog, expected_revision: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let (code, view) = request(log, "GET", "/local/v1/production", "", deadline)?;
    if code != 200
        || view["mode"] != "preparation"
        || view["revision"].as_str() != Some(expected_revision)
    {
        return Err("制作状态已变化，请回到准备中心重新选择外部游戏。".into());
    }
    disconnect_camera(log)?;
    invalidate_local_match_exit(log)
}

/// The Host asks Companion directly immediately before each game submission.
pub fn check_obs_entry(log: &DesktopLog, preparation_id: &str) -> Result<(), String> {
    let token = runtime_token(log)?;
    let body = serde_json::json!({"preparationId": preparation_id}).to_string();
    let (status, value) = request_with_identity(
        log,
        "POST",
        "/operator/runtime/obs-entry-permit",
        &body,
        Instant::now() + Duration::from_secs(6),
        Some(&token),
    )?;
    if status == 200 && value["ok"] == true {
        return Ok(());
    }
    Err(value["message"]
        .as_str()
        .unwrap_or("OBS 启动准备已失效，请重试。")
        .to_string())
}

/// Existing private runtime identity; browsers cannot renew a native lease.
pub fn prepare_mulnx(
    log: &DesktopLog,
    cs2: &std::path::Path,
    update: bool,
    spectator_cfg: bool,
) -> Result<serde_json::Value, String> {
    prepare_mulnx_with_demo(log, cs2, update, spectator_cfg, None, false)
}

pub fn prepare_mulnx_with_demo(
    log: &DesktopLog,
    cs2: &std::path::Path,
    update: bool,
    spectator_cfg: bool,
    demo_cfg: Option<&str>,
    capture_compatibility: bool,
) -> Result<serde_json::Value, String> {
    let token = runtime_token(log)?;
    let console_capture = crate::cs2_console::settings(log)?["enabled"] == true;
    log.event("mulnx_prepare_request", "begin", Some(&serde_json::json!({"cs2Path":cs2.to_string_lossy(),"consoleCapture":console_capture,"update":update,"spectatorCfg":spectator_cfg,"captureCompatibility":capture_compatibility}).to_string()));
    let body = serde_json::json!({"cs2Path": cs2.to_string_lossy(),"consoleCapture":console_capture,"update":update,"spectatorCfg":spectator_cfg,"demoCfg":demo_cfg,"captureCompatibility":capture_compatibility}).to_string();
    let (code, value) = request_with_identity(
        log,
        "POST",
        "/operator/runtime/mulnx-prepare",
        &body,
        Instant::now() + Duration::from_secs(240),
        Some(&token),
    )?;
    if code != 200 {
        log.event(
            "mulnx_prepare",
            "failure",
            Some(&format!("http={code}; response={value}")),
        );
        return Err(value["message"]
            .as_str()
            .unwrap_or("MulNX 准备失败，请重试。")
            .into());
    }
    Ok(value)
}

pub fn camera_session(
    log: &DesktopLog,
    action: &str,
    lease: Option<&str>,
    revision: Option<&str>,
) -> Result<serde_json::Value, String> {
    let token = runtime_token(log)?;
    let mut body = serde_json::json!({"action": action, "host": log.session_id});
    if let Some(lease) = lease {
        body["lease"] = lease.into();
    }
    if let Some(revision) = revision {
        body[if action == "begin-demo" {
            "requestId"
        } else {
            "expectedRevision"
        }] = revision.into();
    }
    let (code, value) = request_with_identity(
        log,
        "POST",
        "/operator/runtime/camera-session",
        &body.to_string(),
        Instant::now() + Duration::from_secs(2),
        Some(&token),
    )?;
    if code != 200 || value["ok"] != true {
        if action == "begin" && code == 409 && value["notStarted"] == true {
            return Err("camera_not_started:运镜准备条件已变化，请重试。".into());
        }
        return Err("原生运镜会话已失效；请结束制作后重新借用。".into());
    }
    Ok(value)
}

pub fn disconnect_camera(log: &DesktopLog) -> Result<(), String> {
    let (code, camera) = request(
        log,
        "POST",
        "/operator/orchestration",
        r#"{"action":"disconnect"}"#,
        Instant::now() + Duration::from_secs(2),
    )?;
    if code != 200 || camera["status"]["held"] != true || camera["status"]["connected"] != false {
        return Err("旧运镜连接未能隔离，请检查本地服务；执行及停止均未确认。".into());
    }
    Ok(())
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
    let revision = state["revision"].as_str().ok_or("制作状态无效。")?;
    let body = serde_json::json!({"action": action, "expectedRevision": revision}).to_string();
    let (status, _) = request(log, "POST", "/operator/production", &body, deadline)?;
    if status != 200 {
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
        let revision = state["revision"].as_str().ok_or("制作状态无效。")?;
        let body = serde_json::json!({"action": action, "expectedRevision": revision}).to_string();
        let (status, result) = request(log, "POST", "/operator/production", &body, deadline)?;
        if status == 200 && result["mode"] == "preparation" {
            return Ok(());
        }
        if status == 409 && result["message"] == "制作状态已变化，请刷新后重试。" {
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
