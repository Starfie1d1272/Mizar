//! Bounded loopback requests and runtime identity for native Companion callers.
use crate::startup_log::DesktopLog;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

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
pub(crate) fn request(
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
        "本场收尾请求未完成。请重试；再次失败时查看诊断。"
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
