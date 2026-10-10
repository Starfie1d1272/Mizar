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

// canonicalize() yields extended paths on Windows. CS2 receives an ordinary
// drive/UNC path, with its own quotes retained through Steam's argument relay.
pub fn playdemo_argument(path: &Path) -> Result<String, String> {
    let path = validate_file(path)?;
    let text = path
        .to_str()
        .ok_or("Demo 路径必须是有效的 Unicode 文本。")?;
    Ok(format!("\"{}\"", engine_path(text)?))
}

fn engine_path(text: &str) -> Result<String, String> {
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        if unc
            .split('\\')
            .take(2)
            .filter(|part| !part.is_empty())
            .count()
            != 2
        {
            return Err("Demo 网络路径无效。".into());
        }
        return Ok(format!(r"\\{unc}"));
    }
    if let Some(drive) = text.strip_prefix(r"\\?\") {
        let bytes = drive.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'\\'
        {
            return Err("Demo 路径不是受支持的游戏文件路径。".into());
        }
        return Ok(drive.into());
    }
    Ok(text.into())
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

pub fn requires_recovery(log: &DesktopLog, journal: Option<&Value>) -> bool {
    if journal.is_some_and(|value| value.get("demoTestRequestId").is_some()) {
        return true;
    }
    // Presence is only a fail-closed recovery hint, never a second source of
    // lifecycle state. All actions and UUIDs still come from Companion RPC.
    match std::fs::symlink_metadata(log.state_root.join("data/demo-test.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        _ => true,
    }
}

pub fn quarantine_if_needed(
    log: &DesktopLog,
    journal: Option<&Value>,
) -> Result<Option<String>, String> {
    if requires_recovery(log, journal) {
        quarantine(log)
    } else {
        Ok(None)
    }
}

pub fn quarantine(log: &DesktopLog) -> Result<Option<String>, String> {
    let state = status(log)?;
    if state["active"] != true {
        return Ok(None);
    }
    let id = state["requestId"]
        .as_str()
        .ok_or("Demo 试播恢复身份无效。")?;
    // Restart recovery already drops all GSI. It can recover while OBS is
    // unavailable; finish would replace that recovery phase with stopping.
    if state["phase"] != "recovery" {
        request(log, "finish", id, None)?;
    }
    Ok(Some(id.into()))
}

pub fn complete(log: &DesktopLog, request_id: Option<&str>) -> Result<(), String> {
    if let Some(id) = request_id {
        request(log, "complete", id, None)?;
    }
    Ok(())
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
        validate_state(parse_response(&response)?)
    })();
    if result.is_err() {
        log.event("demo_test", "failure", Some("phase=companion_request"));
    }
    result
}

fn validate_state(value: Value) -> Result<Value, String> {
    let active = value["active"].as_bool().ok_or("Demo 试播状态无效。")?;
    let phase = value["phase"].as_str().ok_or("Demo 试播阶段无效。")?;
    let valid_id = value["requestId"].as_str().is_some_and(|id| {
        id.len() == 36
            && id.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    });
    if !matches!(
        phase,
        "idle" | "starting" | "playing" | "stopping" | "recovery"
    ) || (active && (phase == "idle" || !valid_id))
        || (!active && (phase != "idle" || !value["requestId"].is_null()))
        || value["teamAName"].as_str().is_none()
        || value["teamBName"].as_str().is_none()
        || value["dataReady"].as_bool().is_none()
    {
        return Err("Demo 试播状态无效。".into());
    }
    Ok(value)
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
        fs::write(&path, b"PBDEMS2\0payload").unwrap();
        assert!(selection.select(&root.join("short.dem")).is_err());
        // A cancelled picker makes no select call; previous capability remains valid.
        assert!(selection
            .resolve(selected["token"].as_str().unwrap())
            .is_ok());
        assert!(playdemo_argument(&path).unwrap().contains("校园 对阵.dem"));
        fs::rename(&path, root.join("moved.dem")).unwrap();
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
        assert!(validate_state(json!({})).is_err());
        let mut state = json!({"active":true,"phase":"recovery","requestId":first,
            "teamAName":"A","teamBName":"B","dataReady":false});
        assert!(validate_state(state.clone()).is_ok());
        state["requestId"] = Value::Null;
        assert!(validate_state(state).is_err());
    }

    #[test]
    fn extended_windows_paths_become_game_paths_without_losing_unicode() {
        assert_eq!(
            engine_path(r"\\?\C:\资料\校园 对阵.dem").unwrap(),
            r"C:\资料\校园 对阵.dem"
        );
        assert_eq!(
            engine_path(r"\\?\UNC\server\共享\校园 对阵.dem").unwrap(),
            r"\\server\共享\校园 对阵.dem"
        );
        assert!(engine_path(r"\\?\Volume{123}\demo.dem").is_err());
        assert!(engine_path(r"\\?\UNC\server\").is_err());
    }

    #[test]
    fn normal_recovery_is_offline_but_demo_evidence_requires_companion() {
        let root = std::env::temp_dir().join(request_id().unwrap());
        let log = DesktopLog::new(&root, None).unwrap();
        std::fs::create_dir_all(log.state_root.join("data")).unwrap();
        assert!(!requires_recovery(
            &log,
            Some(&json!({"launchAttempted":true}))
        ));
        assert!(requires_recovery(
            &log,
            Some(&json!({"demoTestRequestId":"invalid"}))
        ));
        std::fs::write(log.state_root.join("data/demo-test.json"), b"corrupt").unwrap();
        assert!(requires_recovery(&log, None));
        std::fs::remove_file(log.state_root.join("data/demo-test.json")).unwrap();
        assert!(!requires_recovery(&log, None));
        std::fs::remove_dir_all(root).unwrap();
    }
}
