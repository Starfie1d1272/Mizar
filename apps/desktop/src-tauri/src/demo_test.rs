use crate::startup_log::DesktopLog;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

// Match the bounded producer-side aggregation used by DesktopLog: repeated
// recovery failures retain their first evidence and then aggregate at powers of
// two. A new cause starts a new incident; successful status polls do not erase
// the aggregation of a still-failing finish/complete operation.
static RETRY_FAILURE: Mutex<Option<(String, u64)>> = Mutex::new(None);

fn failure(log: &DesktopLog, stage: &str, mut evidence: Value, retry: bool) {
    if retry {
        let key = format!("{}:{stage}:{evidence}", log.session_id);
        if let Ok(mut previous) = RETRY_FAILURE.lock() {
            let count = match previous.as_mut() {
                Some((saved, count)) if *saved == key => {
                    *count = count.saturating_add(1);
                    *count
                }
                _ => {
                    *previous = Some((key, 1));
                    1
                }
            };
            if !count.is_power_of_two() {
                return;
            }
            evidence["occurrences"] = json!(if count == 1 { 1 } else { count / 2 });
        }
    }
    evidence["phase"] = json!(stage);
    log.event("demo_test", "failure", Some(&evidence.to_string()));
}

fn io_failure(
    log: &DesktopLog,
    stage: &str,
    error: &std::io::Error,
    summary: &str,
    retry: bool,
) -> String {
    // File/transport OS errors do not include the selected path or request
    // contents. Reconstruct their system reason from the OS code; arbitrary
    // custom I/O messages are intentionally excluded from evidence.
    let cause = error
        .raw_os_error()
        .map(|code| std::io::Error::from_raw_os_error(code).to_string())
        .unwrap_or_else(|| format!("{:?} (custom detail omitted)", error.kind()));
    failure(
        log,
        stage,
        json!({"errorKind":format!("{:?}",error.kind()),"osCode":error.raw_os_error(),"cause":cause}),
        retry,
    );
    summary.into()
}

fn json_failure(
    log: &DesktopLog,
    stage: &str,
    error: &serde_json::Error,
    summary: &str,
    status: Option<u16>,
) -> String {
    failure(
        log,
        stage,
        json!({"category":format!("{:?}",error.classify()),"line":error.line(),"column":error.column(),"status":status}),
        true,
    );
    summary.into()
}

fn invalid(log: &DesktopLog, stage: &str, cause: &str, summary: &str, retry: bool) -> String {
    failure(log, stage, json!({"cause":cause}), retry);
    summary.into()
}

#[derive(Default)]
pub struct Selection {
    selected: Option<(String, PathBuf)>,
}

impl Selection {
    pub fn select(&mut self, path: &Path, log: &DesktopLog) -> Result<Value, String> {
        let path = validate_file(path, log)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Demo 文件名无效。")?;
        let token = new_request_id(log)?;
        let result = json!({"token":token,"name":name});
        self.selected = Some((token, path));
        Ok(result)
    }

    pub fn resolve(&self, token: &str, log: &DesktopLog) -> Result<PathBuf, String> {
        let (_, path) = self
            .selected
            .as_ref()
            .filter(|(saved, _)| saved == token)
            .ok_or_else(|| {
                invalid(
                    log,
                    "file_selection",
                    "expired_selection",
                    "Demo 选择已失效，请重新选择文件。",
                    false,
                )
            })?;
        validate_file(path, log)
    }
}

pub fn validate_file(path: &Path, log: &DesktopLog) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|error| {
        io_failure(
            log,
            "file_canonicalize",
            &error,
            "Demo 文件无法读取，请重新选择。",
            false,
        )
    })?;
    let text = path.to_str().ok_or_else(|| {
        invalid(
            log,
            "file_path_unicode",
            "non_unicode_path",
            "Demo 路径必须是有效的 Unicode 文本。",
            false,
        )
    })?;
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | ';' | '+'))
    {
        return Err(invalid(
            log,
            "file_path_characters",
            "unsafe_game_argument",
            "Demo 路径包含无法安全用于游戏启动的字符。",
            false,
        ));
    }
    if !path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("dem"))
    {
        return Err(invalid(
            log,
            "file_extension",
            "unsupported_extension",
            "请选择 CS2 的 .dem 文件。",
            false,
        ));
    }
    if !path
        .metadata()
        .map_err(|error| {
            io_failure(
                log,
                "file_metadata",
                &error,
                "Demo 文件信息无法读取。",
                false,
            )
        })?
        .is_file()
    {
        return Err(invalid(
            log,
            "file_type",
            "not_regular_file",
            "请选择普通 Demo 文件。",
            false,
        ));
    }
    let mut file = File::open(&path)
        .map_err(|error| io_failure(log, "file_open", &error, "Demo 文件无法读取。", false))?;
    if !file
        .metadata()
        .map_err(|error| {
            io_failure(
                log,
                "file_handle_metadata",
                &error,
                "Demo 文件信息无法读取。",
                false,
            )
        })?
        .is_file()
    {
        return Err(invalid(
            log,
            "file_handle_type",
            "not_regular_file",
            "请选择普通 Demo 文件。",
            false,
        ));
    }
    let mut header = [0; 8];
    file.read_exact(&mut header)
        .map_err(|error| io_failure(log, "file_header_read", &error, "Demo 文件不完整。", false))?;
    if &header != b"PBDEMS2\0" {
        return Err(invalid(
            log,
            "file_header",
            "invalid_cs2_demo_signature",
            "所选文件不是 CS2 Demo。",
            false,
        ));
    }
    Ok(path)
}

// canonicalize() yields extended paths on Windows. CS2 receives an ordinary
// drive/UNC path, with its own quotes retained through Steam's argument relay.
pub fn playdemo_argument(path: &Path, log: &DesktopLog) -> Result<String, String> {
    let path = validate_file(path, log)?;
    let text = path
        .to_str()
        .ok_or("Demo 路径必须是有效的 Unicode 文本。")?;
    let engine = engine_path(text).map_err(|summary| {
        invalid(
            log,
            "file_engine_path",
            "unsupported_windows_path",
            &summary,
            false,
        )
    })?;
    Ok(format!("\"{engine}\""))
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

#[cfg(test)]
pub fn request_id() -> Result<String, String> {
    random_uuid(None)
}

pub fn new_request_id(log: &DesktopLog) -> Result<String, String> {
    random_uuid(Some(log))
}

fn random_uuid(log: Option<&DesktopLog>) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    #[cfg(windows)]
    {
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(algorithm: isize, buffer: *mut u8, length: u32, flags: u32) -> i32;
        }
        let status = unsafe { BCryptGenRandom(0, bytes.as_mut_ptr(), bytes.len() as u32, 2) };
        if status < 0 {
            if let Some(log) = log {
                failure(
                    log,
                    "random_bytes",
                    json!({"errorKind":"NTSTATUS","status":format!("0x{:08x}",status as u32)}),
                    false,
                );
            }
            return Err("无法创建 Demo 测试身份。".into());
        }
    }
    #[cfg(not(windows))]
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| match log {
            Some(log) => io_failure(
                log,
                "random_bytes",
                &error,
                "无法创建 Demo 测试身份。",
                false,
            ),
            None => "无法创建 Demo 测试身份。".into(),
        })?;
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
    (|| {
        let state_file = File::open(log.state_root.join("data/runtime.json")).map_err(|error| {
            io_failure(
                log,
                "runtime_open",
                &error,
                "无法读取本地服务身份，请重新打开 Mizar。",
                true,
            )
        })?;
        let mut state = Vec::new();
        state_file
            .take(65537)
            .read_to_end(&mut state)
            .map_err(|error| {
                io_failure(
                    log,
                    "runtime_read",
                    &error,
                    "无法读取本地服务身份，请重新打开 Mizar。",
                    true,
                )
            })?;
        if state.len() > 65536 {
            return Err(invalid(
                log,
                "runtime_size",
                "size_limit_exceeded",
                "本地服务身份超出限制，请重新打开 Mizar。",
                true,
            ));
        }
        let state: Value = serde_json::from_slice(&state).map_err(|error| {
            json_failure(
                log,
                "runtime_json",
                &error,
                "本地服务身份无效，请重新打开 Mizar。",
                None,
            )
        })?;
        let token = state["controlToken"]
            .as_str()
            .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
            .ok_or_else(|| {
                invalid(
                    log,
                    "runtime_identity",
                    "invalid_private_capability",
                    "本地服务身份无效，请重新打开 Mizar。",
                    true,
                )
            })?;
        let address: SocketAddr = "127.0.0.1:3000".parse().unwrap();
        let mut stream =
            TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|error| {
                io_failure(
                    log,
                    "tcp_connect",
                    &error,
                    "无法连接本地 Demo 测试服务，请重新打开 Mizar 后重试。",
                    true,
                )
            })?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|error| {
                io_failure(
                    log,
                    "tcp_write_timeout",
                    &error,
                    "Demo 测试连接不可用，请重试。",
                    true,
                )
            })?;
        let (method, route, body) = match body {
            Some(value) => ("POST", "/operator/runtime/demo-test", value.to_string()),
            None => ("GET", "/local/v1/demo-test", String::new()),
        };
        stream.write_all(format!("{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nx-runtime-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
            .map_err(|error| io_failure(log, "tcp_write", &error, "Demo 测试请求未完成，请重试。", true))?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut response = Vec::new();
        loop {
            stream
                .set_read_timeout(Some(
                    deadline
                        .checked_duration_since(Instant::now())
                        .ok_or_else(|| {
                            invalid(
                                log,
                                "response_deadline",
                                "deadline_exceeded",
                                "Demo 测试响应超时，请重试。",
                                true,
                            )
                        })?,
                ))
                .map_err(|error| {
                    io_failure(
                        log,
                        "tcp_read_timeout",
                        &error,
                        "Demo 测试连接不可用，请重试。",
                        true,
                    )
                })?;
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).map_err(|error| {
                io_failure(
                    log,
                    "tcp_read",
                    &error,
                    "Demo 测试响应未完成，请重试。",
                    true,
                )
            })?;
            if count == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..count]);
            if response.len() > 65536 {
                return Err(invalid(
                    log,
                    "response_size",
                    "size_limit_exceeded",
                    "Demo 测试响应超出限制，请重新打开 Mizar 后重试。",
                    true,
                ));
            }
        }
        validate_state(parse_response(&response, log)?).map_err(|summary| {
            invalid(
                log,
                "response_state",
                "invalid_lifecycle_state",
                &summary,
                true,
            )
        })
    })()
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

fn parse_response(bytes: &[u8], log: &DesktopLog) -> Result<Value, String> {
    let text = std::str::from_utf8(bytes).map_err(|error| {
        failure(
            log,
            "response_utf8",
            json!({"validUpTo":error.valid_up_to(),"errorLength":error.error_len()}),
            true,
        );
        "Demo 测试响应无效，请重新打开 Mizar 后重试。".to_string()
    })?;
    let (headers, body) = text.split_once("\r\n\r\n").ok_or_else(|| {
        invalid(
            log,
            "response_headers",
            "missing_header_separator",
            "Demo 测试响应格式无效，请重试。",
            true,
        )
    })?;
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        return Err(invalid(
            log,
            "response_encoding",
            "unsupported_transfer_encoding",
            "Demo 测试响应格式不支持，请重新打开 Mizar 后重试。",
            true,
        ));
    }
    let mut status = headers
        .lines()
        .next()
        .ok_or_else(|| {
            invalid(
                log,
                "response_status",
                "missing_status_line",
                "Demo 测试响应格式无效，请重试。",
                true,
            )
        })?
        .split_whitespace();
    if status.next() != Some("HTTP/1.1") {
        return Err(invalid(
            log,
            "response_status",
            "unsupported_http_version",
            "Demo 测试响应格式无效，请重试。",
            true,
        ));
    }
    let code = status
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|code| (100..=599).contains(code))
        .ok_or_else(|| {
            invalid(
                log,
                "response_status",
                "invalid_http_status",
                "Demo 测试响应格式无效，请重试。",
                true,
            )
        })?;
    for line in headers.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length")
                && value.trim().parse::<usize>().ok() != Some(body.len())
            {
                return Err(invalid(
                    log,
                    "response_length",
                    "content_length_mismatch",
                    "Demo 测试响应不完整，请重试。",
                    true,
                ));
            }
        }
    }
    let value: Value = serde_json::from_str(body).map_err(|error| {
        json_failure(
            log,
            "response_json",
            &error,
            "Demo 测试响应无效，请重试。",
            Some(code),
        )
    })?;
    if code != 200 {
        failure(
            log,
            "response_http",
            json!({"status":code,"cause":"companion_rejected","reason":rejection_reason(value["message"].as_str())}),
            true,
        );
        return Err(value["message"]
            .as_str()
            .unwrap_or("Demo 测试操作未完成，请重试。")
            .into());
    }
    Ok(value)
}

fn rejection_reason(message: Option<&str>) -> &'static str {
    // DesktopLog bounds messages but cannot remove unknown paths or secrets.
    // Only fixed messages in the private Demo contract may enter native logs;
    // neither response bodies nor a future dynamic reason are copied through.
    const REASONS: &[&str] = &[
        "试播操作参数无效。",
        "试播操作正在进行，请稍后重试。",
        "试播状态已变化，请刷新后重试。",
        "制作操作正在进行，请稍后重试。",
        "已有试播需要先结束。",
        "本机试播存储尚未就绪。",
        "比赛资料正在修改，请完成后再试播。",
        "请连接 OBS 并停止推流后再开始试播。",
        "请先结束制作，完成升级或素材激活后再开始试播。",
        "当前试播不能开始播放。",
        "播放已开始，请先结束试播。",
        "请先切换等待画面并退出受管 CS2。",
        "试播操作未完成，隔离状态已保留；请处理问题后重试。",
    ];
    REASONS
        .iter()
        .copied()
        .find(|reason| Some(*reason) == message)
        .unwrap_or("[unknown rejection reason redacted]")
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
        let log = DesktopLog::new(&root, None).unwrap();
        let mut selection = Selection::default();
        let selected = selection.select(&path, &log).unwrap();
        assert_eq!(selected["name"], "校园 对阵.dem");
        assert!(selected.get("path").is_none());
        assert!(selection.resolve("arbitrary path", &log).is_err());
        assert_eq!(
            selection
                .resolve(selected["token"].as_str().unwrap(), &log)
                .unwrap(),
            path.canonicalize().unwrap()
        );
        fs::write(&path, b"HL2DEMO\0payload").unwrap();
        assert!(selection
            .resolve(selected["token"].as_str().unwrap(), &log)
            .is_err());
        fs::write(root.join("injection;+quit.dem"), b"PBDEMS2\0").unwrap();
        assert!(validate_file(&root.join("injection;+quit.dem"), &log).is_err());
        assert!(validate_file(&root, &log).is_err());
        fs::write(root.join("short.dem"), b"PBDEMS2").unwrap();
        assert!(validate_file(&root.join("short.dem"), &log).is_err());
        fs::write(&path, b"PBDEMS2\0payload").unwrap();
        assert!(selection.select(&root.join("short.dem"), &log).is_err());
        // A cancelled picker makes no select call; previous capability remains valid.
        assert!(selection
            .resolve(selected["token"].as_str().unwrap(), &log)
            .is_ok());
        assert!(playdemo_argument(&path, &log)
            .unwrap()
            .contains("校园 对阵.dem"));
        fs::rename(&path, root.join("moved.dem")).unwrap();
        assert!(selection
            .resolve(selected["token"].as_str().unwrap(), &log)
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_rpc_response_rejects_failures_and_bad_framing() {
        let root = std::env::temp_dir().join(request_id().unwrap());
        let log = DesktopLog::new(&root, None).unwrap();
        assert_eq!(
            parse_response(
                b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"active\":true}",
                &log
            )
            .unwrap()["active"],
            true
        );
        assert_eq!(
            parse_response(b"HTTP/1.1 409 Conflict\r\n\r\n{\"message\":\"busy\"}", &log)
                .unwrap_err(),
            "busy"
        );
        assert!(parse_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{}",
            &log
        )
        .is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n\r\ninvalid", &log).is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}", &log).is_err());
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
        fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn diagnostics_keep_failure_evidence_without_private_data_or_retry_storms() {
        let root = std::env::temp_dir().join(request_id().unwrap());
        let log = DesktopLog::new(&root, None).unwrap();
        fs::create_dir_all(log.state_root.join("data")).unwrap();
        let private_name = "private-competition-credential.dem";
        assert!(validate_file(&root.join(private_name), &log).is_err());
        fs::write(
            log.state_root.join("data/runtime.json"),
            b"{\"controlToken\":\"private-runtime-secret\"",
        )
        .unwrap();
        assert!(status(&log).is_err());
        assert!(parse_response(b"HTTP/1.1 403 Forbidden\r\n\r\n{\"message\":\"private-runtime-secret C:\\\\private\\\\demo.dem\"}", &log).is_err());
        let reason = "请连接 OBS 并停止推流后再开始试播。";
        let rejected = format!("HTTP/1.1 409 Conflict\r\n\r\n{}", json!({"message":reason}));
        assert_eq!(
            parse_response(rejected.as_bytes(), &log).unwrap_err(),
            reason
        );
        fs::remove_file(log.state_root.join("data/runtime.json")).unwrap();
        for _ in 0..10000 {
            assert!(status(&log).is_err());
        }
        let text = fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        assert!(text.len() < 64 * 1024);
        assert!(!text.contains(root.to_str().unwrap()));
        assert!(!text.contains(private_name));
        assert!(!text.contains("private-runtime-secret"));
        assert!(!text.contains("private\\\\demo.dem"));
        let evidence: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| entry["stage"] == "demo_test")
            .map(|entry| serde_json::from_str(entry["error"].as_str().unwrap()).unwrap())
            .collect();
        assert!(evidence
            .iter()
            .any(|entry| entry["phase"] == "file_canonicalize"
                && entry["errorKind"] == "NotFound"
                && entry["osCode"].is_number()));
        assert!(evidence.iter().any(|entry| entry["phase"] == "runtime_json"
            && entry["category"] == "Eof"
            && entry["line"] == 1
            && entry["column"].as_u64().unwrap() > 0));
        assert!(evidence
            .iter()
            .any(|entry| entry["phase"] == "response_http" && entry["status"] == 403));
        assert!(evidence
            .iter()
            .any(|entry| entry["phase"] == "response_http"
                && entry["status"] == 409
                && entry["reason"] == reason));
        assert!(evidence.iter().any(|entry| entry["phase"] == "runtime_open"
            && entry["occurrences"].as_u64().is_some_and(|value| value > 1)));
        fs::remove_dir_all(root).unwrap();
    }
}
