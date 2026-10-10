use crate::startup_log::DesktopLog;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
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
        let mut signature = evidence.clone();
        // A fresh Companion operation UUID identifies each attempted retry;
        // it must not turn the same persistent failure into a log storm.
        if let Some(fields) = signature.as_object_mut() {
            fields.remove("operationId");
        }
        let key = format!("{}:{stage}:{signature}", log.session_id);
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

// CS2 14190 leaves startup +playdemo in DELAYED COMMAND without starting it.
// Execute the validated path from a per-session CFG, after the input service
// has initialized. The journal reserves its identity before any file is created.
pub fn playback_cfg_plan(request_id: &str, argument: &str) -> Result<Value, String> {
    let id = json!(request_id);
    if safe_uuid(Some(&id)).filter(|id| *id != "[invalid UUID redacted]") != Some(request_id) {
        return Err("Demo 启动标识无效。".into());
    }
    if argument.len() < 2
        || argument.len() > 32_768
        || !argument.starts_with('"')
        || !argument.ends_with('"')
        || argument[1..argument.len() - 1]
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | ';'))
    {
        return Err("Demo 播放路径无效。".into());
    }
    Ok(json!({"name":format!("mizar_demo_{request_id}.cfg"),
        "content":format!("playdemo {}\n", argument.replace('\\', "/"))}))
}

fn playback_cfg_file(journal: &Value) -> Result<(PathBuf, &str), String> {
    let id = safe_uuid(journal.get("demoTestRequestId"))
        .filter(|id| *id != "[invalid UUID redacted]")
        .ok_or("Demo 启动记录无效。")?;
    let record = &journal["demoPlaybackCfg"];
    let expected = format!("mizar_demo_{id}.cfg");
    if record["name"].as_str() != Some(expected.as_str()) {
        return Err("Demo 播放 CFG 记录无效。".into());
    }
    let executable = Path::new(journal["executable"].as_str().ok_or("游戏安装记录缺失。")?);
    if !executable.is_absolute() {
        return Err("游戏安装记录无效。".into());
    }
    let directory = crate::cs2_spectator::cfg_path(executable)?;
    let content = record["content"]
        .as_str()
        .filter(|s| s.len() <= 32_800)
        .ok_or("Demo 播放 CFG 内容记录无效。")?;
    Ok((directory.with_file_name(expected), content))
}

pub fn install_playback_cfg(journal: &Value) -> Result<(), (String, bool)> {
    install_playback_cfg_with(journal, |file, bytes| {
        file.write_all(bytes).and_then(|_| file.sync_all())
    })
}

pub(crate) fn install_playback_cfg_with(
    journal: &Value,
    write: impl FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
) -> Result<(), (String, bool)> {
    let (path, content) = playback_cfg_file(journal).map_err(|e| (e, false))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| {
            (
                crate::cs2_session::io_error("Demo 播放 CFG 无法创建，已有文件保持原样。", &e),
                false,
            )
        })?;
    write(&mut file, content.as_bytes()).map_err(|e| {
        (
            crate::cs2_session::io_error("Demo 播放 CFG 未能完整保存。", &e),
            true,
        )
    })
}

pub(crate) fn playback_cleanup_id(journal: &Value) -> Result<&str, String> {
    playback_cfg_file(journal)?;
    journal["demoTestRequestId"]
        .as_str()
        .ok_or("Demo 清理标识缺失。".into())
}

pub fn cleanup_playback_cfg(journal: &Value) -> Result<(), String> {
    if journal.get("demoPlaybackCfg").is_none() {
        return Ok(());
    }
    let (path, content) = playback_cfg_file(journal)?;
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(crate::cs2_session::io_error("Demo 播放 CFG 无法核实。", &e)),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() || m.len() != content.len() as u64 => {
            return Err("Demo 播放 CFG 已变化，原文件和恢复记录仍保留。".into())
        }
        _ => (),
    }
    if fs::read(&path).map_err(|e| crate::cs2_session::io_error("Demo 播放 CFG 无法读回。", &e))?
        != content.as_bytes()
    {
        return Err("Demo 播放 CFG 已变化，原文件和恢复记录仍保留。".into());
    }
    fs::remove_file(path).map_err(|e| crate::cs2_session::io_error("Demo 播放 CFG 尚未清理。", &e))
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
        failure(log, "response_http", rejection_evidence(&value, code), true);
        return Err(value["message"]
            .as_str()
            .unwrap_or("Demo 测试操作未完成，请重试。")
            .into());
    }
    Ok(value)
}

fn rejection_evidence(value: &Value, status: u16) -> Value {
    json!({"status":status,"cause":"companion_rejected",
        "code":safe_identifier(value.get("error").or_else(|| value.get("code"))),
        "stage":safe_identifier(value.get("stage")),
        "operationId":safe_uuid(value.get("operationId")),
        "requestId":safe_uuid(value.get("requestId"))})
}

fn safe_identifier(value: Option<&Value>) -> Option<&str> {
    value.map(|value| {
        value.as_str().filter(|text| {
            !text.is_empty() && text.len() <= 64
                && text.as_bytes()[0].is_ascii_alphabetic()
                && text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                // Bare long hex strings are capabilities rather than useful
                // machine codes. Do not copy one even in a mislabeled field.
                && !(text.len() >= 32 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
        }).unwrap_or("[invalid identifier redacted]")
    })
}

fn safe_uuid(value: Option<&Value>) -> Option<&str> {
    value.map(|value| {
        value
            .as_str()
            .filter(|id| {
                id.len() == 36
                    && id.bytes().enumerate().all(|(index, byte)| {
                        if [8, 13, 18, 23].contains(&index) {
                            byte == b'-'
                        } else {
                            byte.is_ascii_hexdigit()
                        }
                    })
                    && matches!(id.as_bytes()[14], b'1'..=b'8')
                    && matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
            })
            .unwrap_or("[invalid UUID redacted]")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn playback_cfg_is_owned_and_recovered_without_overwriting_collisions() {
        let root = std::env::temp_dir().join(request_id().unwrap());
        let executable = root.join("game/bin/win64/cs2.exe");
        let cfg = root.join("game/csgo/cfg");
        fs::create_dir_all(&cfg).unwrap();
        let id = request_id().unwrap();
        let record = playback_cfg_plan(&id, "\"D:\\校园 对阵.dem\"").unwrap();
        assert_eq!(record["content"], "playdemo \"D:/校园 对阵.dem\"\n");
        let journal =
            json!({"executable":executable,"demoTestRequestId":id,"demoPlaybackCfg":record});
        let (path, _) = playback_cfg_file(&journal).unwrap();
        fs::write(&path, b"user config").unwrap();
        assert!(install_playback_cfg(&journal).is_err());
        assert!(cleanup_playback_cfg(&journal).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"user config");
        fs::remove_file(&path).unwrap();
        install_playback_cfg(&journal).unwrap();
        cleanup_playback_cfg(&journal).unwrap();
        cleanup_playback_cfg(&journal).unwrap();
        assert!(!path.exists());
        assert!(playback_cfg_plan("../unsafe", "\"D:/demo.dem\"").is_err());
        assert!(playback_cfg_plan("[invalid UUID redacted]", "\"D:/demo.dem\"").is_err());
        assert!(playback_cfg_plan(&id, "\"").is_err());
        assert!(playback_cfg_plan(&id, "\"D:/demo.dem\";+quit").is_err());
        fs::remove_dir_all(root).unwrap();
    }
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
        let invalid = format!(
            "HTTP/1.1 401 Unauthorized\r\n\r\n{}",
            json!({
            "error":"C:\\private\\demo.dem","stage":"private-runtime-secret/path",
            "operationId":"private-runtime-secret","requestId":"private-runtime-secret"})
        );
        assert!(parse_response(invalid.as_bytes(), &log).is_err());
        let capability = "abcdef0123456789".repeat(4);
        let mislabeled = format!(
            "HTTP/1.1 400 Bad Request\r\n\r\n{}",
            json!({"code":capability,"stage":capability})
        );
        assert!(parse_response(mislabeled.as_bytes(), &log).is_err());
        let reason = "请连接 OBS 并停止推流后再开始试播。";
        let operation = request_id().unwrap();
        let trial = request_id().unwrap();
        let rejection = json!({"message":reason,"error":"demo_test_future_failure",
            "stage":"waiting_take","operationId":operation,"requestId":trial});
        let rejected = format!("HTTP/1.1 409 Conflict\r\n\r\n{rejection}");
        assert_eq!(
            parse_response(rejected.as_bytes(), &log).unwrap_err(),
            reason
        );
        // New operation IDs correlate individual retries without defeating
        // aggregation of an unchanged machine cause within the same trial.
        for _ in 0..10000 {
            let mut retry = rejection.clone();
            retry["operationId"] = json!(request_id().unwrap());
            let response = format!("HTTP/1.1 409 Conflict\r\n\r\n{retry}");
            assert!(parse_response(response.as_bytes(), &log).is_err());
        }
        fs::remove_file(log.state_root.join("data/runtime.json")).unwrap();
        for _ in 0..10000 {
            assert!(status(&log).is_err());
        }
        let text = fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        assert!(text.len() < 64 * 1024);
        assert!(!text.contains(root.to_str().unwrap()));
        assert!(!text.contains(private_name));
        assert!(!text.contains("private-runtime-secret"));
        assert!(!text.contains(&capability));
        assert!(!text.contains("private\\\\demo.dem"));
        assert!(!text.contains(reason));
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
                && entry["code"] == "demo_test_future_failure"
                && entry["stage"] == "waiting_take"
                && entry["operationId"] == operation
                && entry["requestId"] == trial));
        assert!(evidence.iter().any(|entry| entry["status"] == 401
            && entry["code"] == "[invalid identifier redacted]"
            && entry["operationId"] == "[invalid UUID redacted]"));
        assert!(evidence.iter().any(|entry| entry["status"] == 400
            && entry["code"] == "[invalid identifier redacted]"
            && entry["stage"] == "[invalid identifier redacted]"));
        assert!(evidence.iter().any(|entry| entry["phase"] == "runtime_open"
            && entry["occurrences"].as_u64().is_some_and(|value| value > 1)));
        fs::remove_dir_all(root).unwrap();
    }
}
