use crate::startup_log::DesktopLog;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Selection {
    selected: Option<(String, PathBuf)>,
}

impl Selection {
    pub fn clear(&mut self) {
        self.selected = None;
    }

    pub fn select(&mut self, path: &Path) -> Result<Value, String> {
        let path = validate_file(path)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Demo 文件名无效。")?;
        let token = request_id()?;
        let result = json!({"token":token,"name":name});
        self.selected = Some((token, path));
        Ok(result)
    }

    pub fn resolve(&self, token: &str) -> Result<PathBuf, String> {
        let (_, path) = self
            .selected
            .as_ref()
            .filter(|(saved, _)| saved == token)
            .ok_or("Demo 选择已失效，请重新选择文件。")?;
        validate_file(path)
    }
}

pub fn validate_file(path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|_| "Demo 文件无法读取，请重新选择。")?;
    let text = path
        .to_str()
        .ok_or("Demo 路径必须是有效的 Unicode 文本。")?;
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | ';' | '+'))
    {
        return Err("Demo 路径包含无法安全用于游戏启动的字符。".into());
    }
    if !path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("dem"))
    {
        return Err("请选择 CS2 的 .dem 文件。".into());
    }
    if !path
        .metadata()
        .map_err(|_| "Demo 文件信息无法读取。")?
        .is_file()
    {
        return Err("请选择普通 Demo 文件。".into());
    }
    let mut file = File::open(&path).map_err(|_| "Demo 文件无法读取。")?;
    if !file
        .metadata()
        .map_err(|_| "Demo 文件信息无法读取。")?
        .is_file()
    {
        return Err("请选择普通 Demo 文件。".into());
    }
    let mut header = [0; 8];
    file.read_exact(&mut header)
        .map_err(|_| "Demo 文件不完整。")?;
    if &header != b"PBDEMS2\0" {
        return Err("所选文件不是 CS2 Demo。".into());
    }
    Ok(path)
}

pub fn request_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    #[cfg(windows)]
    {
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(algorithm: isize, buffer: *mut u8, length: u32, flags: u32) -> i32;
        }
        if unsafe { BCryptGenRandom(0, bytes.as_mut_ptr(), bytes.len() as u32, 2) } < 0 {
            return Err("无法创建 Demo 测试身份。".into());
        }
    }
    #[cfg(not(windows))]
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| "无法创建 Demo 测试身份。")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|v| format!("{v:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

pub fn status(log: &DesktopLog) -> Result<Value, String> {
    rpc(log, None)
}

pub fn request(
    log: &DesktopLog,
    action: &str,
    request_id: &str,
    teams: Option<(&str, &str)>,
) -> Result<Value, String> {
    if !matches!(
        action,
        "begin" | "playing" | "finish" | "complete" | "cancel"
    ) {
        return Err("Demo 测试操作无效。".into());
    }
    let mut body = json!({"action":action,"requestId":request_id});
    if let Some((a, b)) = teams {
        body["teamAName"] = json!(a);
        body["teamBName"] = json!(b);
    }
    rpc(log, Some(body))
}

fn rpc(log: &DesktopLog, body: Option<Value>) -> Result<Value, String> {
    let result = (|| {
        let state_file = File::open(log.state_root.join("data/runtime.json"))
            .map_err(|_| "无法读取本地服务身份。")?;
        let mut state = Vec::new();
        state_file
            .take(65537)
            .read_to_end(&mut state)
            .map_err(|_| "无法读取本地服务身份。")?;
        if state.len() > 65536 {
            return Err("本地服务身份超出限制。".into());
        }
        let state: Value = serde_json::from_slice(&state).map_err(|_| "本地服务身份无效。")?;
        let token = state["controlToken"]
            .as_str()
            .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or("本地服务身份无效。")?;
        let address: SocketAddr = "127.0.0.1:3000".parse().unwrap();
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
            .map_err(|_| "无法连接本地 Demo 测试服务。")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| "Demo 测试连接不可用。")?;
        let (method, route, body) = match body {
            Some(value) => ("POST", "/operator/runtime/demo-test", value.to_string()),
            None => ("GET", "/local/v1/demo-test", String::new()),
        };
        stream.write_all(format!("{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nx-runtime-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
            .map_err(|_| "Demo 测试请求未完成。")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut response = Vec::new();
        loop {
            stream
                .set_read_timeout(Some(
                    deadline
                        .checked_duration_since(Instant::now())
                        .ok_or("Demo 测试响应超时。")?,
                ))
                .map_err(|_| "Demo 测试连接不可用。")?;
            let mut chunk = [0; 4096];
            let count = stream
                .read(&mut chunk)
                .map_err(|_| "Demo 测试响应未完成。")?;
            if count == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..count]);
            if response.len() > 65536 {
                return Err("Demo 测试响应超出限制。".into());
            }
        }
        parse_response(&response)
    })();
    if result.is_err() {
        log.event("demo_test", "failure", Some("phase=companion_request"));
    }
    result
}

fn parse_response(bytes: &[u8]) -> Result<Value, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Demo 测试响应无效。")?;
    let (headers, body) = text
        .split_once("\r\n\r\n")
        .ok_or("Demo 测试响应格式无效。")?;
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        return Err("Demo 测试响应格式不支持。".into());
    }
    let mut status = headers
        .lines()
        .next()
        .ok_or("Demo 测试响应格式无效。")?
        .split_whitespace();
    if status.next() != Some("HTTP/1.1") {
        return Err("Demo 测试响应格式无效。".into());
    }
    let code = status.next().ok_or("Demo 测试响应格式无效。")?;
    for line in headers.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length")
                && value.trim().parse::<usize>().ok() != Some(body.len())
            {
                return Err("Demo 测试响应不完整。".into());
            }
        }
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "Demo 测试响应无效。")?;
    if code != "200" {
        return Err(value["message"]
            .as_str()
            .unwrap_or("Demo 测试操作未完成，请重试。")
            .into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn selected_file_stays_native_and_is_revalidated() {
        let root = std::env::temp_dir().join(request_id().unwrap());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("校园 对阵.dem");
        fs::write(&path, b"PBDEMS2\0payload").unwrap();
        let mut selection = Selection::default();
        let selected = selection.select(&path).unwrap();
        assert_eq!(selected["name"], "校园 对阵.dem");
        assert!(selected.get("path").is_none());
        assert!(selection.resolve("arbitrary path").is_err());
        assert_eq!(
            selection
                .resolve(selected["token"].as_str().unwrap())
                .unwrap(),
            path.canonicalize().unwrap()
        );
        fs::write(&path, b"HL2DEMO\0payload").unwrap();
        assert!(selection
            .resolve(selected["token"].as_str().unwrap())
            .is_err());
        fs::write(root.join("injection;+quit.dem"), b"PBDEMS2\0").unwrap();
        assert!(validate_file(&root.join("injection;+quit.dem")).is_err());
        assert!(validate_file(&root).is_err());
        fs::write(root.join("short.dem"), b"PBDEMS2").unwrap();
        assert!(validate_file(&root.join("short.dem")).is_err());
        selection.clear();
        assert!(selection
            .resolve(selected["token"].as_str().unwrap())
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_rpc_response_rejects_failures_and_bad_framing() {
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"active\":true}")
                .unwrap()["active"],
            true
        );
        assert_eq!(
            parse_response(b"HTTP/1.1 409 Conflict\r\n\r\n{\"message\":\"busy\"}").unwrap_err(),
            "busy"
        );
        assert!(
            parse_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{}").is_err()
        );
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n\r\ninvalid").is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}").is_err());
        let first = request_id().unwrap();
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "4");
        assert_ne!(first, request_id().unwrap());
    }
}
