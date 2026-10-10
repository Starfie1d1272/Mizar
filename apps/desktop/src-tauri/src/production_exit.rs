//! Host exit and managed CS2 cleanup preserve Companion production safety boundaries.
use crate::startup_log::DesktopLog;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
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
}
impl ExitGate {
    pub fn begin(&self) -> bool {
        !self.active.swap(true, Ordering::AcqRel)
    }
    pub fn check(&self) -> Result<(), String> {
        if self.active.load(Ordering::Acquire) {
            Err("Mizar 正在退出，请完成收尾后再启动。".into())
        } else {
            Ok(())
        }
    }
    pub fn cancel(&self) {
        self.active.store(false, Ordering::Release);
    }
}

pub fn finish_then_restore(
    finish: impl FnOnce() -> Result<(), String>,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    finish()?;
    restore()
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

fn request_with_identity(
    log: &DesktopLog,
    method: &str,
    path: &str,
    body: &str,
    deadline: Instant,
    token: Option<&str>,
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

fn runtime_token(log: &DesktopLog) -> Result<String, String> {
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
    confirm: impl FnOnce(serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    let qualification = prepare();
    // Cleanup is required even if the private Companion handshake is unavailable.
    finish(matches!(&qualification, Ok(Some(_))))?;
    match qualification {
        Ok(Some(qualification)) => confirm(qualification).map_err(|_| EXIT_UNCONFIRMED.into()),
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
        |qualification| confirm_local_match_exit(log, qualification),
    )
}

pub fn finish_companion(log: &DesktopLog) -> Result<(), String> {
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
        let body =
            serde_json::json!({"action": "shutdown", "expectedRevision": revision}).to_string();
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
#[cfg(test)]
mod tests {
    use super::*;
    fn qualification() -> serde_json::Value {
        serde_json::json!({"ticket": "private-ticket", "matchId": "match-7", "contextRevision": "revision-9"})
    }

    #[test]
    fn game_cleanup_and_process_check_must_succeed_before_confirmation() {
        let confirmed = std::cell::Cell::new(false);
        for error in [
            "restore failed",
            "external CS2 still running",
            "process query failed",
        ] {
            let result = finish_with_qualification(
                || Ok(Some(qualification())),
                |requires_proof| {
                    assert!(requires_proof);
                    Err(error.into())
                },
                |_| {
                    confirmed.set(true);
                    Ok(())
                },
            );
            assert_eq!(result.unwrap_err(), error);
            assert!(!confirmed.get());
        }
        let calls = std::cell::RefCell::new(Vec::new());
        finish_with_qualification(
            || { calls.borrow_mut().push("prepare"); Ok(Some(qualification())) },
            |requires_proof| {
                assert!(requires_proof);
                calls.borrow_mut().extend(["cleanup", "process-check"]);
                Ok(())
            },
            |captured| {
                assert_eq!(captured, serde_json::json!({"ticket": "private-ticket", "matchId": "match-7", "contextRevision": "revision-9"}));
                calls.borrow_mut().push("confirm");
                Ok(())
            },
        ).unwrap();
        assert_eq!(
            *calls.borrow(),
            ["prepare", "cleanup", "process-check", "confirm"]
        );
    }

    #[test]
    fn absent_or_failed_qualification_still_cleans_up_without_acknowledgement() {
        for prepared in [Ok(None), Err("Companion unavailable".into())] {
            let failed = prepared.is_err();
            let cleaned = std::cell::Cell::new(false);
            let result = finish_with_qualification(
                || prepared,
                |requires_proof| {
                    assert!(!requires_proof);
                    cleaned.set(true);
                    Ok(())
                },
                |_| panic!("No qualification may be acknowledged"),
            );
            assert!(cleaned.get());
            if failed {
                assert_eq!(result.unwrap_err(), EXIT_UNCONFIRMED);
            } else {
                result.unwrap();
            }
        }
        assert_eq!(
            finish_with_qualification(
                || Ok(Some(qualification())),
                |_| Ok(()),
                |_| Err("409: stale ticket".into()),
            )
            .unwrap_err(),
            EXIT_UNCONFIRMED
        );
    }

    #[test]
    fn private_handshake_uses_token_without_origin_and_preserves_captured_identity() {
        let token = "a".repeat(64);
        let body =
            serde_json::json!({"action": "confirm", "qualification": qualification()}).to_string();
        let wire = wire_request("POST", EXIT_ENDPOINT, &body, Some(&token));
        let (headers, payload) = wire.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with("POST /operator/runtime/local-match-exit HTTP/1.1\r\n"));
        assert!(headers.contains(&format!("\r\nx-runtime-token: {token}\r\n")));
        assert!(!headers.to_ascii_lowercase().contains("origin:"));
        let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({"action": "confirm", "qualification": {
                "ticket": "private-ticket", "matchId": "match-7", "contextRevision": "revision-9"
            }})
        );
        assert!(wire_request("GET", "/local/v1/production", "", None)
            .contains("Origin: http://127.0.0.1:3000\r\n"));
    }

    #[test]
    fn malformed_private_runtime_identity_is_bounded_and_never_logged() {
        let root = std::env::temp_dir().join(format!(
            "mizar-exit-identity-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = DesktopLog::new(&root, None).unwrap();
        std::fs::create_dir_all(log.state_root.join("data")).unwrap();
        let path = log.state_root.join("data/runtime.json");
        let token = "b".repeat(64);
        for input in [
            format!(r#"{{"controlToken":"{token}","secret":}}"#),
            "c".repeat(64 * 1024 + 1),
            r#"{"controlToken":"private-token"}"#.into(),
        ] {
            std::fs::write(&path, input).unwrap();
            let error = runtime_token(&log).unwrap_err();
            assert!(!error.contains(&token) && !error.contains("private-token"));
        }
        std::fs::write(
            &path,
            serde_json::json!({"controlToken": token}).to_string(),
        )
        .unwrap();
        assert_eq!(runtime_token(&log).unwrap(), token);
        let evidence = std::fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        assert!(evidence.contains("runtime_json") && evidence.contains("size_limit_exceeded"));
        assert!(!evidence.contains(&token) && !evidence.contains("private-token"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_verified_stop_skips_an_already_completed_production_request() {
        let stop = VerifiedStop::default();
        assert!(!stop.complete());
        stop.mark();
        assert!(stop.complete());
        let calls = std::cell::RefCell::new(Vec::new());
        finish_then_restore(
            || {
                if !stop.complete() {
                    calls.borrow_mut().push("http");
                }
                Ok(())
            },
            || {
                calls.borrow_mut().push("game-close-and-restore");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), vec!["game-close-and-restore"]);
    }
    #[test]
    fn safe_finish_precedes_game_close_and_failure_keeps_game() {
        let calls = std::cell::RefCell::new(Vec::new());
        finish_then_restore(
            || {
                calls.borrow_mut().push("waiting-and-release");
                Ok(())
            },
            || {
                calls.borrow_mut().push("game-close-and-restore");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *calls.borrow(),
            vec!["waiting-and-release", "game-close-and-restore"]
        );
        calls.borrow_mut().clear();
        assert!(finish_then_restore(
            || Err("OBS failed".into()),
            || {
                calls.borrow_mut().push("game-close");
                Ok(())
            }
        )
        .is_err());
        assert!(calls.borrow().is_empty());
    }
    #[test]
    fn exit_rejects_new_launch_and_allows_cleanup_retry() {
        let gate = ExitGate::default();
        assert!(gate.check().is_ok());
        assert!(gate.begin());
        assert!(!gate.begin());
        assert!(gate.check().is_err());
        gate.cancel();
        assert!(gate.check().is_ok());
        assert!(gate.begin());
        assert!(gate.check().is_err());
    }
}
