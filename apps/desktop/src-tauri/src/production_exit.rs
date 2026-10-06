//! Normal Host exit reuses Companion's safe production finish before touching CS2.
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

fn request(
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
        .map_err(|_| "无法连接制作服务，游戏与备份仍保留。")?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| "制作收尾未完成。")?;
    stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: http://127.0.0.1:3000\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).map_err(|_| "制作收尾请求未完成。")?;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("制作收尾超时，请重试。")?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "制作收尾未完成。")?;
        let mut buffer = [0; 4096];
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "制作收尾响应未完成，游戏与备份仍保留。")?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > 64 * 1024 {
            return Err("制作收尾响应无效。".into());
        }
    }
    let response = std::str::from_utf8(&bytes).map_err(|_| "制作收尾响应无效。")?;
    let (headers, payload) = response
        .split_once("\r\n\r\n")
        .ok_or("制作收尾响应无效。")?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("制作收尾响应无效。")?;
    // Fastify's JSON responses have Content-Length. Fail closed on other framing.
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        return Err("制作收尾响应格式不支持。".into());
    }
    let value = serde_json::from_str(payload).map_err(|_| "制作收尾响应无效。")?;
    Ok((status, value))
}
pub fn finish_companion() -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    for _ in 0..3 {
        let (status, state) = request("GET", "/local/v1/production", "", deadline)?;
        if status != 200 {
            return Err("无法读取制作状态，游戏仍保留。".into());
        }
        let revision = state["revision"].as_str().ok_or("制作状态无效。")?;
        let body =
            serde_json::json!({"action": "shutdown", "expectedRevision": revision}).to_string();
        let (status, result) = request("POST", "/operator/production", &body, deadline)?;
        if status == 200 && result["mode"] == "preparation" {
            return Ok(());
        }
        if status == 409 && result["message"] == "制作状态已变化，请刷新后重试。" {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
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
