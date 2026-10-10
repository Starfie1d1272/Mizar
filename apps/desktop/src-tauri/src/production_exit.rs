//! Normal Host exit reuses Companion's safe production finish before touching CS2.
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
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .ok_or("制作收尾超时，请重试。")?;
    let address: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let mut stream = TcpStream::connect_timeout(&address, timeout.min(Duration::from_secs(1)))
        .map_err(|error| {
            io_failure(
                log,
                "tcp_connect",
                &error,
                "无法连接制作服务，游戏与备份仍保留。",
            )
        })?;
    stream.set_write_timeout(Some(timeout)).map_err(|error| {
        io_failure(
            log,
            "tcp_write_timeout",
            &error,
            "收尾请求通信设置失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
        )
    })?;
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: http://127.0.0.1:3000\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).map_err(|error| io_failure(log, "tcp_write", &error, "收尾请求发送失败，游戏和备份仍保留。请查看诊断，处理后再次退出。"))?;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("制作收尾超时，请重试。")?;
        stream.set_read_timeout(Some(remaining)).map_err(|error| {
            io_failure(
                log,
                "tcp_read_timeout",
                &error,
                "收尾请求通信设置失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
            )
        })?;
        let mut buffer = [0; 4096];
        let count = stream.read(&mut buffer).map_err(|error| {
            io_failure(
                log,
                "tcp_read",
                &error,
                "收尾服务响应读取失败，游戏和备份仍保留。请查看诊断，处理后再次退出。",
            )
        })?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 64 * 1024 {
            return Err(
                "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。".into(),
            );
        }
    }
    let response = std::str::from_utf8(&bytes).map_err(|error| {
        log.event(
            "production_finish",
            "failure",
            Some(&format!("phase=response_utf8; cause={error}")),
        );
        "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。"
    })?;
    let (headers, payload) = response
        .split_once("\r\n\r\n")
        .ok_or("收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。")?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。")?;
    // Fastify's JSON responses have Content-Length. Fail closed on other framing.
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        return Err("制作收尾响应格式不支持。".into());
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
        "收尾服务响应无法解析，游戏和备份仍保留。请查看诊断，处理后再次退出。"
    })?;
    Ok((status, value))
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
