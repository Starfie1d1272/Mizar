use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, TryLockError,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

mod metadata;
use metadata::{
    delivery_request_active, pin_protection, process_instance, read_delivery_json, read_pin_json,
    recover_pin_metadata, remove_missing_ok, write_delivery_json,
};

thread_local! {
    static TASK_CONTEXT: std::cell::RefCell<Value> = const { std::cell::RefCell::new(Value::Null) };
}
struct TaskContextGuard(Value);
impl Drop for TaskContextGuard {
    fn drop(&mut self) {
        TASK_CONTEXT.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}
fn diagnostic_uuid(value: Option<&str>) -> Option<&str> {
    value.filter(|text| {
        text.len() == 36
            && text.bytes().enumerate().all(|(i, byte)| {
                if [8, 13, 18, 23].contains(&i) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
    })
}

pub const LOG_LIMIT: u64 = 1024 * 1024;
const MESSAGE_LIMIT: usize = 8192;

#[derive(Clone)]
pub struct DesktopLog {
    inner: Arc<Mutex<LogFile>>,
    deferred: Arc<DeferredLog>,
    started: Instant,
    pub directory: PathBuf,
    pub state_root: PathBuf,
    pub session_id: String,
}

const DEFERRED_LOG_BYTES: usize = 512 * 1024;
const DEFERRED_LOG_EVENTS: usize = 256;
#[derive(Clone)]
struct DeferredEvent {
    stage: String,
    result: String,
    detail: Option<String>,
    context: Value,
    observed_at: String,
    monotonic_ms: u128,
    bytes: usize,
}
#[derive(Default)]
struct DeferredQueue {
    entries: std::collections::VecDeque<DeferredEvent>,
    bytes: usize,
}
#[derive(Default)]
struct DeferredLog {
    queue: Mutex<DeferredQueue>,
    overflow: AtomicU64,
    contended: AtomicU64,
    failed: AtomicU64,
    total_lost: AtomicU64,
    lost_bytes: AtomicU64,
    first_lost_ms: AtomicU64,
    last_lost_ms: AtomicU64,
}
fn add_count(counter: &AtomicU64, count: u64) {
    let mut current = counter.load(Ordering::Relaxed);
    while let Err(value) = counter.compare_exchange_weak(
        current,
        current.saturating_add(count),
        Ordering::Relaxed,
        Ordering::Relaxed,
    ) {
        current = value;
    }
}

struct LogFile {
    directory: PathBuf,
    identity: Value,
    limit: u64,
    page_loads: u64,
    sequence: u64,
    segment_name: String,
    document_segment_name: String,
    active_segments: Vec<String>,
    // In-flight seal/hash work belongs to this same producer, not another ledger.
    pin_work: std::collections::HashMap<String, Vec<String>>,
    write_poisoned: bool,
    retention_issue: Option<String>,
}

struct PinWork {
    inner: Arc<Mutex<LogFile>>,
    pin_id: String,
}
impl Drop for PinWork {
    fn drop(&mut self) {
        if let Ok(mut log) = self.inner.lock() {
            log.pin_work.remove(&self.pin_id);
        }
    }
}
fn pin_source_name(name: &str) -> bool {
    name.strip_prefix("desktop-")
        .or_else(|| name.strip_prefix("document-"))
        .and_then(|name| name.strip_suffix(".ndjson"))
        .is_some_and(|id| diagnostic_uuid(Some(id)).is_some())
}
fn hash_pin_sources(
    directory: &Path,
    sources: &[Value],
    verify: bool,
) -> Result<Vec<Value>, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    if sources.len() > 4096 {
        return Err("诊断固定源超出预算。".into());
    }
    let mut segments = Vec::new();
    for segment in sources {
        let name = segment["name"]
            .as_str()
            .filter(|name| pin_source_name(name))
            .ok_or("固定文件路径无效。")?;
        let size = segment["bytes"]
            .as_u64()
            .filter(|size| *size <= 2 * 1024 * 1024)
            .ok_or("固定大小无效。")?;
        let path = directory.join(name);
        #[cfg(windows)]
        let _parents =
            crate::support_export::hold_directories(directory).map_err(|e| e.to_string())?;
        let (mut file, _) = crate::support_export::checked(&path).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() != size {
            return Err("固定文件已变化。".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut read = 0u64;
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            read += n as u64;
            if read > size {
                return Err("固定文件已变化。".into());
            }
            hash.update(&buffer[..n]);
        }
        if read != size {
            return Err("固定文件已变化。".into());
        }
        let digest = format!("{:x}", hash.finalize());
        if verify && segment["sha256"] != digest {
            return Err("固定文件摘要不匹配。".into());
        }
        segments.push(json!({"name":name,"bytes":size,"sha256":digest}));
    }
    Ok(segments)
}
fn pin_identity(
    receipt: &Value,
    pin_id: &str,
    kind: &str,
    owner: Option<&Value>,
) -> Result<(), String> {
    if receipt["schema"] != "mizar-producer-pin/2"
        || receipt["producerKind"] != "host"
        || receipt["pinId"] != pin_id
        || receipt["kind"] != kind
        || (kind == "delivery" && receipt.get("deliveryOwner") != owner)
    {
        return Err("诊断固定回执不匹配。".into());
    }
    Ok(())
}
fn pin_current(receipt: &Value) -> Result<(), String> {
    if !matches!(receipt["state"].as_str(), Some("prepared" | "committed")) {
        return Err("诊断固定状态无效。".into());
    }
    if receipt["expiresAt"].is_null()
        && receipt["state"] == "committed"
        && matches!(receipt["kind"].as_str(), Some("incident" | "active"))
    {
        return Ok(());
    }
    let deadline = receipt["expiresAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .ok_or("诊断固定租约无效。")?;
    if deadline <= Utc::now() {
        return Err("诊断固定租约已到期，请重新固定。".into());
    }
    Ok(())
}

fn reserve_segment(directory: &Path, prefix: &str) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);
    for _ in 0..32 {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let digest = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}:{stamp}:{}",
                    std::process::id(),
                    NONCE.fetch_add(1, Ordering::Relaxed)
                )
                .as_bytes()
            )
        );
        let name = format!(
            "{prefix}-{}-{}-4{}-8{}-{}.ndjson",
            &digest[..8],
            &digest[8..12],
            &digest[13..16],
            &digest[17..20],
            &digest[20..32]
        );
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(&name))
        {
            Ok(file) => {
                file.sync_all()?;
                return Ok(name);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("diagnostic segment reservation exhausted"))
}

fn append_committed(log: &mut LogFile, path: &Path, bytes: &[u8]) -> io::Result<()> {
    if log.write_poisoned {
        return Err(io::Error::other("diagnostic append repair required"));
    }
    let mut file = OpenOptions::new().write(true).open(path)?;
    let start = file.seek(SeekFrom::End(0))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_data()) {
        if file.set_len(start).and_then(|_| file.sync_data()).is_err() {
            // Preserve uncertain bytes for recovery; never append/ACK over a partial record.
            log.write_poisoned = true;
        }
        return Err(error);
    }
    Ok(())
}

fn normalized(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn is_payload(state: &Path, payload: &Path) -> bool {
    // The product is Windows-only; case differences must not bypass the payload boundary.
    let state = state.to_string_lossy().to_lowercase();
    let payload = payload.to_string_lossy().to_lowercase();
    state == payload || state.starts_with(&format!("{payload}{}", std::path::MAIN_SEPARATOR))
}

pub fn writable_root(root: &Path, override_path: Option<PathBuf>) -> io::Result<PathBuf> {
    let default = if let Some(path) = override_path {
        path
    } else if root.join("installed.flag").is_file() {
        PathBuf::from(
            std::env::var_os("LOCALAPPDATA")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "用户数据目录不可用。"))?,
        )
        .join("Mizar")
    } else {
        root.join("state")
    };
    let state = normalized(&default);
    if !state.is_absolute() || is_payload(&state, &normalized(&root.join("resources"))) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "运行数据目录必须是程序资源目录以外的绝对路径。",
        ));
    }
    fs::create_dir_all(&state)?;
    let state = state.canonicalize()?;
    if let Ok(payload) = root.join("resources").canonicalize() {
        if is_payload(&state, &payload) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "运行数据目录不能位于程序资源目录内。",
            ));
        }
    }
    Ok(state)
}

fn credential_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    [
        "password",
        "passwd",
        "token",
        "secret",
        "credential",
        "authorization",
        "cookie",
        "streamkey",
        "apikey",
    ]
    .iter()
    .any(|word| key.contains(word))
}

/// Preserve technical context while removing credentials embedded in text.
pub(crate) fn redact_text(text: &str) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static BEARER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)\b(Bearer|Basic)\s+[^\s\"',}]+"#).unwrap());
    static COOKIE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?im)(\b(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]*").unwrap());
    static FIELD: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b((?:[a-z0-9_-]*(?:password|passwd|token|secret|credential)|authorization|cookie|set-cookie|api[_-]?key|stream[_-]?key|ticket)[\"']?\s*[:=]\s*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;}&?#]+)"#).unwrap()
    });
    static USERINFO: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)([a-z][a-z0-9+.-]{0,31}://)[^/\s\"'<>@]+@"#).unwrap());
    static RTMP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)(rtmps?://[^/\s\"'<>]+/(?:[^/\s\"'<>]+/)+)[^/\s\"'<>?#]+"#).unwrap()
    });
    static LOGIN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"rh_mizar_[a-zA-Z0-9_-]+").unwrap());
    let text = BEARER.replace_all(text, "$1 [redacted]");
    let text = COOKIE.replace_all(&text, "$1[redacted]");
    let text = FIELD.replace_all(&text, "$1[redacted]");
    let text = USERINFO.replace_all(&text, "$1[redacted]@");
    let text = RTMP.replace_all(&text, "$1[redacted]");
    LOGIN.replace_all(&text, "[redacted]").into_owned()
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    let value = if credential_key(&key) {
                        json!("[redacted]")
                    } else {
                        redact_value(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(fields) => Value::Array(fields.into_iter().map(redact_value).collect()),
        Value::String(text) if text.starts_with("http://") || text.starts_with("https://") => {
            if let Some((path, query)) = text.split_once('?') {
                let query = query
                    .split('&')
                    .map(|part| {
                        if let Some((key, value)) = part.split_once('=') {
                            format!(
                                "{key}={}",
                                if credential_key(key) || ["code", "key", "auth"].contains(&key) {
                                    "[redacted]"
                                } else {
                                    value
                                }
                            )
                        } else {
                            part.to_owned()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("&");
                json!(redact_text(&format!("{path}?{query}")))
            } else {
                json!(redact_text(&text))
            }
        }
        Value::String(text) => json!(redact_text(&text)),
        other => other,
    }
}

impl DesktopLog {
    pub fn new(root: &Path, state_override: Option<PathBuf>) -> io::Result<Self> {
        let state_root = writable_root(root, state_override)?;
        let directory = state_root.join("logs");
        fs::create_dir_all(&directory)?;
        let ticks = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        use sha2::{Digest, Sha256};
        let entropy = format!(
            "{:x}",
            Sha256::digest(format!("{ticks}:{}", std::process::id()).as_bytes())
        );
        let session_id = format!(
            "{}-{}-4{}-8{}-{}",
            &entropy[..8],
            &entropy[8..12],
            &entropy[13..16],
            &entropy[17..20],
            &entropy[20..32]
        );
        let artifact_path = root.join("resources/metadata/artifact.json");
        let artifact: Value = fs::metadata(&artifact_path)
            .ok()
            .filter(|m| m.len() <= 32768)
            .and_then(|_| fs::read(&artifact_path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let digest = |name: &str, length: usize| {
            artifact[name]
                .as_str()
                .filter(|value| {
                    value.len() == length && value.bytes().all(|c| c.is_ascii_hexdigit())
                })
                .map(str::to_owned)
        };
        let identity = json!({
            "schemaVersion": 1,
            "startupSessionId": session_id,
            "gitSha": digest("gitSha", 40),
            "artifactSha256": digest("artifactSha256", 64),
            "appVersion": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "pid": std::process::id(),
        });
        let logger = Self {
            inner: Arc::new(Mutex::new(LogFile {
                directory: directory.clone(),
                identity,
                limit: LOG_LIMIT,
                page_loads: 0,
                sequence: 0,
                segment_name: reserve_segment(&directory, "desktop")?,
                document_segment_name: reserve_segment(&directory, "document")?,
                active_segments: Vec::new(),
                pin_work: std::collections::HashMap::new(),
                write_poisoned: false,
                retention_issue: None,
            })),
            deferred: Arc::new(DeferredLog::default()),
            started: Instant::now(),
            directory,
            state_root,
            session_id,
        };
        let recovery = recover_pin_metadata(&logger.directory);
        logger.event("process_start", "success", None);
        match recovery {
            Ok(outcomes) if !outcomes.is_empty() => {
                let result = if outcomes.iter().any(|item| item["result"] == "retained") {
                    "partial"
                } else {
                    "success"
                };
                logger.event(
                    "native_diagnostic_metadata_recovery",
                    result,
                    Some(&json!({"files":outcomes}).to_string()),
                );
            }
            Err(error) => logger.event(
                "native_diagnostic_metadata_recovery",
                "partial",
                Some(&json!({"reason":error.to_string()}).to_string()),
            ),
            _ => (),
        }
        let retention_issue = logger
            .inner
            .lock()
            .ok()
            .and_then(|log| log.retention_issue.clone());
        if let Some(reason) = retention_issue {
            logger.event(
                "native_diagnostic_retention_paused",
                "partial",
                Some(&json!({"reason":reason,"action":"preserve-originals"}).to_string()),
            );
        }
        logger.start_delivery_pins();
        Ok(logger)
    }

    pub fn committed_event(
        &self,
        stage: &str,
        result: &str,
        detail: Option<&str>,
    ) -> io::Result<()> {
        self.write_mode(stage, result, detail, true)
    }
    fn write_mode(
        &self,
        stage: &str,
        result: &str,
        detail: Option<&str>,
        durable: bool,
    ) -> io::Result<()> {
        let observed_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let monotonic_ms = self.started.elapsed().as_millis();
        let mut log = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("desktop log lock unavailable"))?;
        Self::write_locked(
            &mut log,
            stage,
            result,
            detail,
            durable,
            Some((&observed_at, monotonic_ms)),
        )
    }
    fn write_locked(
        log: &mut LogFile,
        stage: &str,
        result: &str,
        detail: Option<&str>,
        durable: bool,
        observed_at: Option<(&str, u128)>,
    ) -> io::Result<()> {
        // Preserve each navigation in the full retained product log.
        if stage == "main_page_load" && result == "success" {
            log.page_loads = log.page_loads.saturating_add(1);
        }
        if let Some(detail) = detail {
            let clean = serde_json::from_str::<Value>(detail)
                .map(redact_value)
                .map(|value| value.to_string())
                .unwrap_or_else(|_| redact_text(detail));
            if clean.len() > MESSAGE_LIMIT {
                let mut chunks = Vec::new();
                let mut start = 0;
                while start < clean.len() {
                    let mut end = (start + MESSAGE_LIMIT).min(clean.len());
                    while !clean.is_char_boundary(end) {
                        end -= 1;
                    }
                    chunks.push(&clean[start..end]);
                    start = end;
                }
                let detail_id = format!(
                    "{:x}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                );
                for (index, text) in chunks.iter().enumerate() {
                    Self::write_entry(log, stage, result, Some(&json!({"detailId":detail_id,"part":index + 1,"parts":chunks.len(),"text":text}).to_string()), durable, observed_at)?;
                }
                return Ok(());
            }
            Self::write_entry(log, stage, result, Some(&clean), durable, observed_at)
        } else {
            Self::write_entry(log, stage, result, None, durable, observed_at)
        }
    }

    fn write_entry(
        log: &mut LogFile,
        stage: &str,
        result: &str,
        detail: Option<&str>,
        durable: bool,
        observed_at: Option<(&str, u128)>,
    ) -> io::Result<()> {
        log.sequence += 1;
        let mut entry = log.identity.clone();
        entry["schema"] = json!("mizar-diagnostic-event/2");
        entry["producerKind"] = json!("host");
        entry["producerRunId"] = entry["startupSessionId"].clone();
        entry["sequence"] = json!(log.sequence);
        entry["eventId"] = json!(format!(
            "{}:{}",
            entry["startupSessionId"].as_str().unwrap_or("unknown"),
            log.sequence
        ));
        entry["kind"] = json!(stage);
        entry["phase"] = json!(result);
        entry["outcome"] = json!(result);
        entry["parentOperationId"] = Value::Null;
        entry["attemptId"] = Value::Null;
        entry["scope"] = Value::Null;
        entry["monotonicMs"] =
            observed_at.map_or(Value::Null, |(_, milliseconds)| json!(milliseconds));
        entry["sourceInterval"] = Value::Null;
        entry["coverage"] = json!({"durability":"committed","unknown":["cross-process-clock-order","native-memory-only-tail"],"excluded":[],"replayCount":0,"occurrences":1});
        entry["trigger"] = json!("system");
        entry["taskId"] = Value::Null;
        entry["operationId"] = Value::Null;
        TASK_CONTEXT.with(|slot| {
            if let Value::Object(context) = &*slot.borrow() {
                for (key, value) in context {
                    entry[key] = value.clone();
                }
            }
        });
        entry["time"] = json!(observed_at
            .map(|(time, _)| time.to_owned())
            .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)));
        entry["observedAt"] = entry["time"].clone();
        entry["recordedAt"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        if stage == "native_diagnostic_coverage_gap" {
            entry["coverage"]["unknown"] =
                json!(["cross-process-clock-order", "native-event-buffer-loss"]);
        }
        entry["stage"] = json!(stage);
        entry["result"] = json!(result);
        entry["evidence"] = detail
            .map(|text| {
                serde_json::from_str::<Value>(text)
                    .map(redact_value)
                    .unwrap_or_else(|_| json!({"text":redact_text(text)}))
            })
            .unwrap_or(Value::Null);
        if stage == "native_diagnostic_coverage_gap" {
            entry["sourceInterval"] = json!({"from":entry["evidence"]["firstObservedAt"],"to":entry["evidence"]["lastObservedAt"]});
        }
        if stage == "main_page_load" && result == "success" {
            entry["occurrences"] = json!(1);
        }
        let mut bytes = serde_json::to_vec(&entry)?;
        bytes.push(b'\n');
        let mut current = log.directory.join(&log.segment_name);
        if fs::metadata(&current).map_or(0, |m| m.len()) + bytes.len() as u64 > log.limit {
            Self::collect_segments(log, bytes.len() as u64)?;
            let sealed = log.segment_name.clone();
            log.active_segments.push(sealed);
            log.segment_name = reserve_segment(&log.directory, "desktop")?;
            current = log.directory.join(&log.segment_name);
        }
        if fs::metadata(&current)?.len() == 0 {
            Self::collect_segments(log, LOG_LIMIT)?;
        }
        let _ = durable;
        append_committed(log, &current, &bytes)?;
        Ok(())
    }

    /// A document retains its immutable IDs until this fsync receipt is returned.
    pub fn persist_document_events(&self, events: &[Value]) -> Result<Value, String> {
        if events.is_empty()
            || events.len() > 64
            || serde_json::to_vec(events).map_err(|e| e.to_string())?.len() > 256 * 1024
        {
            return Err("诊断交接批次超出限制。".into());
        }
        let mut log = self.inner.lock().map_err(|_| "诊断写入暂不可用。")?;
        let mut ids = Vec::new();
        let mut bytes = Vec::new();
        for event in events {
            let run =
                diagnostic_uuid(event["producerRunId"].as_str()).ok_or("诊断文档身份无效。")?;
            let sequence = event["sequence"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("诊断序号无效。")?;
            let expected = format!("{run}:{sequence}");
            if event["schema"] != "mizar-diagnostic-event/2"
                || event["producerKind"] != "document"
                || event["eventId"] != expected
                || !event["coverage"].is_object()
                || !event["evidence"].is_object()
                || event["kind"]
                    .as_str()
                    .is_none_or(|v| v.is_empty() || v.len() > 160)
                || event["recordedAt"]
                    .as_str()
                    .is_none_or(|v| chrono::DateTime::parse_from_rfc3339(v).is_err())
            {
                return Err("诊断信封无效。".into());
            }
            let mut clean = redact_value(event.clone());
            clean["coverage"]["durability"] = json!("committed");
            serde_json::to_writer(&mut bytes, &clean).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            ids.push(expected);
        }
        // Dedicated document carrier: retries preserve identity and readers deduplicate by eventId.
        let mut path = self.directory.join(&log.document_segment_name);
        if fs::metadata(&path).map_or(0, |m| m.len()) + bytes.len() as u64 > LOG_LIMIT {
            Self::collect_segments(&mut log, bytes.len() as u64).map_err(|e| e.to_string())?;
            let current = log.document_segment_name.clone();
            log.active_segments.push(current);
            log.document_segment_name =
                reserve_segment(&log.directory, "document").map_err(|e| e.to_string())?;
            path = self.directory.join(&log.document_segment_name);
        }
        if fs::metadata(&path).map_or(0, |m| m.len()) + bytes.len() as u64 > 100 * 1024 * 1024 {
            return Err("诊断文档保留空间已满。".into());
        }
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() == 0 {
            Self::collect_segments(&mut log, LOG_LIMIT).map_err(|e| e.to_string())?;
        }
        append_committed(&mut log, &path, &bytes).map_err(|e| e.to_string())?;
        Ok(json!({"eventIds":ids}))
    }

    fn collect_segments(log: &mut LogFile, incoming: u64) -> io::Result<()> {
        use std::collections::HashSet;
        let mut protected: HashSet<String> = log.active_segments.iter().cloned().collect();
        protected.insert(log.segment_name.clone());
        protected.insert(log.document_segment_name.clone());
        protected.extend(log.pin_work.values().flatten().cloned());
        let (extra, may_delete) = match pin_protection(&log.directory) {
            Ok((pinned, extra)) => {
                protected.extend(pinned);
                log.retention_issue = None;
                (extra, true)
            }
            Err(error) => {
                log.retention_issue = Some(error.to_string());
                (HashSet::new(), false)
            }
        };
        let mut files = Vec::new();
        let mut ordinary = 0u64;
        for entry in fs::read_dir(&log.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("desktop-") || name.starts_with("document-"))
                || !name.ends_with(".ndjson")
            {
                continue;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(io::Error::other("unsafe host segment"));
            }
            if !extra.contains(&name) {
                ordinary += meta.len();
            }
            files.push((meta.modified()?, name, meta.len()));
        }
        files.sort();
        for (time, name, bytes) in files {
            if !may_delete || protected.contains(&name) {
                continue;
            }
            if ordinary + incoming <= 100 * 1024 * 1024
                && SystemTime::now()
                    .duration_since(time)
                    .unwrap_or_default()
                    .as_secs()
                    <= 14 * 86400
            {
                continue;
            }
            if fs::metadata(log.directory.join("host-retention.ndjson"))
                .map(|m| m.len() >= 4 * 1024 * 1024)
                .unwrap_or(false)
            {
                return Err(io::Error::other("host retention evidence ledger capacity"));
            }
            let evidence = json!({"schema":"mizar-host-retention/2","name":name,"bytes":bytes,"reason":"un pinned age or capacity","recordedAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)});
            let mut record = OpenOptions::new()
                .create(true)
                .append(true)
                .open(log.directory.join("host-retention.ndjson"))?;
            serde_json::to_writer(&mut record, &evidence)?;
            record.write_all(b"\n")?;
            record.sync_data()?;
            fs::remove_file(log.directory.join(&name))?;
            ordinary = ordinary.saturating_sub(bytes);
        }
        if ordinary + incoming > 100 * 1024 * 1024 {
            return Err(io::Error::other(if may_delete {
                "host pinned retention budget"
            } else {
                "host retention paused: pin protection requires recovery"
            }));
        }
        Ok(())
    }

    /// Pin state and collection use this producer's lock. Full source hashing
    /// happens outside it, protected by the same owner's in-flight source set.
    pub fn diagnostic_pin(&self, action: &str, pin_id: &str, kind: &str) -> Result<Value, String> {
        if kind == "delivery" {
            return Err("诊断交付固定仅允许内部生产者请求。".into());
        }
        self.diagnostic_pin_owned(action, pin_id, kind, None)
    }

    fn diagnostic_pin_owned(
        &self,
        action: &str,
        pin_id: &str,
        kind: &str,
        delivery_owner: Option<Value>,
    ) -> Result<Value, String> {
        if diagnostic_uuid(Some(pin_id)).is_none()
            || !["incident", "export", "delivery", "active"].contains(&kind)
            || !["prepare", "commit", "release"].contains(&action)
        {
            return Err("诊断固定请求无效。".into());
        }
        let directory = self.directory.join("host-pins");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("诊断固定路径无效。".into());
        }
        let path = directory.join(format!("{pin_id}.json"));
        let (mut receipt, previous, _work) = {
            let mut log = self.inner.lock().map_err(|_| "诊断写入锁不可用。")?;
            if log.pin_work.contains_key(pin_id) || log.pin_work.len() >= 4 {
                return Err("诊断固定操作进行中。".into());
            }
            if path
                .with_extension("partial")
                .try_exists()
                .map_err(|e| e.to_string())?
            {
                return Err("诊断固定记录尚待恢复，请重启 Mizar 后重试。".into());
            }
            let previous = read_pin_json(&path).map_err(|e| e.to_string())?;
            if let Some(receipt) = &previous {
                // Validate the on-disk identity on ALL actions, including release.
                // Changing the caller's kind cannot revoke another kind's hold.
                pin_identity(receipt, pin_id, kind, delivery_owner.as_ref())?;
            }
            if action == "release" {
                if previous
                    .as_ref()
                    .is_some_and(|receipt| receipt["kind"] == "delivery")
                    && delivery_request_active(&self.directory, previous.as_ref().unwrap())
                        .map_err(|e| e.to_string())?
                {
                    return Err("诊断交付固定仍由活动请求持有。".into());
                }
                remove_missing_ok(&path).map_err(|e| e.to_string())?;
                return Ok(json!({"pinId":pin_id,"state":"released"}));
            }
            if action == "prepare" {
                if let Some(previous) = previous {
                    pin_current(&previous)?;
                    return Ok(previous);
                }
            }
            let receipt = if action == "prepare" {
                let mut segments = Vec::new();
                for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !pin_source_name(&name) {
                        continue;
                    }
                    let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
                    if !meta.is_file() || meta.file_type().is_symlink() {
                        return Err("诊断固定源无效。".into());
                    }
                    if meta.len() == 0 {
                        continue;
                    }
                    if meta.len() > 2 * 1024 * 1024 || segments.len() >= 4096 {
                        return Err("诊断固定源超出预算。".into());
                    }
                    segments.push(json!({"name":name,"bytes":meta.len()}));
                }
                // Seal live carriers before dropping the producer lock; the
                // source names are never reused while background hashing runs.
                if segments
                    .iter()
                    .any(|segment| segment["name"] == log.segment_name)
                {
                    let next =
                        reserve_segment(&log.directory, "desktop").map_err(|e| e.to_string())?;
                    let sealed = std::mem::replace(&mut log.segment_name, next);
                    log.active_segments.push(sealed);
                }
                if segments
                    .iter()
                    .any(|segment| segment["name"] == log.document_segment_name)
                {
                    let next =
                        reserve_segment(&log.directory, "document").map_err(|e| e.to_string())?;
                    let sealed = std::mem::replace(&mut log.document_segment_name, next);
                    log.active_segments.push(sealed);
                }
                let mut receipt = json!({"sourceState":self.deferred_source_state(),"schema":"mizar-producer-pin/2","pinId":pin_id,"producerKind":"host","producerRunId":self.session_id,"kind":kind,"state":"prepared","expiresAt":(Utc::now()+chrono::Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Millis,true),"segments":segments});
                if let Some(owner) = &delivery_owner {
                    receipt["deliveryOwner"] = owner.clone();
                }
                receipt
            } else {
                let receipt = previous.clone().ok_or("诊断固定回执缺失。")?;
                pin_current(&receipt)?;
                receipt
            };
            let sources = receipt["segments"]
                .as_array()
                .filter(|sources| sources.len() <= 4096)
                .ok_or("固定范围无效。")?;
            let names: Result<Vec<String>, String> = sources
                .iter()
                .map(|source| {
                    source["name"]
                        .as_str()
                        .filter(|name| pin_source_name(name))
                        .map(str::to_owned)
                        .ok_or_else(|| "固定文件路径无效。".into())
                })
                .collect();
            log.pin_work.insert(pin_id.to_owned(), names?);
            (
                receipt,
                previous,
                PinWork {
                    inner: self.inner.clone(),
                    pin_id: pin_id.to_owned(),
                },
            )
        };
        // No DesktopLog mutex is held across these full-source reads. A slow
        // hash cannot serialize every native command's normal event logging.
        receipt["segments"] = json!(hash_pin_sources(
            &self.directory,
            receipt["segments"].as_array().ok_or("固定范围无效。")?,
            action == "commit"
        )?);
        let _log = self.inner.lock().map_err(|_| "诊断写入锁不可用。")?;
        if read_pin_json(&path).map_err(|e| e.to_string())? != previous {
            return Err("诊断固定回执已变化。".into());
        }
        pin_current(&receipt)?;
        if action == "commit" && kind == "incident" {
            let reservation_path = self.directory.join("incident-pins.json");
            let metadata = fs::symlink_metadata(&reservation_path).map_err(|e| e.to_string())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 4 * 1024 * 1024
            {
                return Err("现场证据额度预留无效。".into());
            }
            let reservations: Value =
                serde_json::from_slice(&fs::read(reservation_path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let mark = reservations["marks"]
                .as_array()
                .and_then(|marks| {
                    marks.iter().find(|mark| {
                        mark["pinId"] == pin_id
                            && ["reserved", "partial", "committed"]
                                .contains(&mark["status"].as_str().unwrap_or(""))
                    })
                })
                .ok_or("现场证据额度尚未预留。")?;
            let host = mark["receipts"]
                .as_array()
                .and_then(|receipts| receipts.iter().find(|r| r["producerId"] == "host"))
                .ok_or("Host 固定额度尚未确认。")?;
            for segment in receipt["segments"].as_array().ok_or("固定范围无效。")? {
                if !host["segments"].as_array().is_some_and(|segments| {
                    segments.iter().any(|s| {
                        s["name"] == segment["name"]
                            && s["bytes"] == segment["bytes"]
                            && s["sha256"] == segment["sha256"]
                    })
                }) {
                    return Err("固定范围与额度预留不匹配。".into());
                }
            }
        }
        if action == "commit" {
            receipt["state"] = json!("committed");
            if kind != "export" && kind != "delivery" {
                receipt["expiresAt"] = Value::Null;
            }
        }
        crate::support_export::write_metadata(&path, &receipt).map_err(|e| e.to_string())?;
        Ok(receipt)
    }

    fn start_delivery_pins(&self) {
        let weak = Arc::downgrade(&self.inner);
        let directory = self.directory.clone();
        let state_root = self.state_root.clone();
        let session_id = self.session_id.clone();
        let deferred = self.deferred.clone();
        let started = self.started;
        // The original producer seals/commits under its lock; full-source
        // hashing in this background thread does not hold that writer lock.
        let _ = std::thread::Builder::new()
            .name("diagnostic-delivery-pins".into())
            .spawn(move || {
                let mut last_error = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    let Some(inner) = weak.upgrade() else { break };
                    let owner = Self {
                        inner,
                        deferred: deferred.clone(),
                        started,
                        directory: directory.clone(),
                        state_root: state_root.clone(),
                        session_id: session_id.clone(),
                    };
                    // I/O failures leave the wire and original evidence untouched.
                    // Never recursively log a diagnostic writer failure through
                    // that same writer. Pin cleanup remains independent of drain.
                    let before = owner.drain_deferred();
                    let pins = owner.poll_delivery_pins();
                    let after = owner.drain_deferred();
                    match before.and(pins).and(after) {
                        Ok(()) => last_error = None,
                        Err(error) => {
                            let detail = error.to_string();
                            if last_error.as_ref() != Some(&detail) {
                                eprintln!("诊断后台写入/固定失败：{detail}");
                                last_error = Some(detail);
                            }
                        }
                    }
                }
            });
    }

    fn poll_delivery_pins(&self) -> io::Result<()> {
        let directory = self.directory.join("host-delivery-pins");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let metadata = fs::symlink_metadata(&directory)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::other("unsafe delivery request directory"));
        }
        let mut ids = std::collections::BTreeSet::new();
        for (index, entry) in entries.enumerate() {
            if index >= 256 {
                return Err(io::Error::other("delivery request inventory budget"));
            }
            let name = entry?.file_name().to_string_lossy().into_owned();
            let id = name
                .strip_suffix(".response.json")
                .or_else(|| name.strip_suffix(".json"));
            if let Some(id) = id.filter(|id| diagnostic_uuid(Some(id)).is_some()) {
                ids.insert(id.to_owned());
            }
        }
        // Responses can be removed by the caller before the next poll. Include
        // native receipts so no completed operation leaves an orphan ledger file.
        if let Ok(pins) = fs::read_dir(self.directory.join("host-pins")) {
            for (index, entry) in pins.enumerate() {
                if index >= 256 {
                    return Err(io::Error::other("delivery pin inventory budget"));
                }
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(id) = name
                    .strip_suffix(".json")
                    .filter(|id| diagnostic_uuid(Some(id)).is_some())
                {
                    if read_pin_json(&entry.path())?
                        .as_ref()
                        .is_some_and(|pin| pin["kind"] == "delivery")
                    {
                        ids.insert(id.to_owned());
                    }
                }
            }
        }
        for pin_id in ids {
            let path = directory.join(format!("{pin_id}.json"));
            let response_path = directory.join(format!("{pin_id}.response.json"));
            let request = read_delivery_json(&path)?;
            let receipt_path = self
                .directory
                .join("host-pins")
                .join(format!("{pin_id}.json"));
            let receipt = read_pin_json(&receipt_path)?;
            if let Some(receipt) = &receipt {
                if receipt["kind"] == "delivery"
                    && !delivery_request_active(&self.directory, receipt)?
                    && (receipt["state"] == "committed"
                        || request.is_none()
                        || receipt["expiresAt"]
                            .as_str()
                            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                            .is_some_and(|at| at <= Utc::now()))
                {
                    self.diagnostic_pin_owned(
                        "release",
                        &pin_id,
                        "delivery",
                        receipt.get("deliveryOwner").cloned(),
                    )
                    .map_err(io::Error::other)?;
                }
            }
            let Some(request) = request else {
                remove_missing_ok(&response_path)?;
                continue;
            };
            if request["schema"] != "mizar-host-delivery-request/1"
                || request["pinId"] != pin_id
                || diagnostic_uuid(request["requestId"].as_str()).is_none()
                || !matches!(request["action"].as_str(), Some("prepare" | "commit"))
            {
                continue;
            }
            let Some(pid) = request["ownerPid"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .filter(|pid| *pid > 0)
            else {
                continue;
            };
            let identity = process_instance(pid)?;
            let requested_instance = request["ownerInstance"].as_str();
            if identity.is_none()
                || (requested_instance.is_some() && identity.as_deref() != requested_instance)
            {
                remove_missing_ok(&path)?;
                remove_missing_ok(&response_path)?;
                continue;
            }
            if read_delivery_json(&response_path)?
                .as_ref()
                .is_some_and(|response| response["requestId"] == request["requestId"])
            {
                continue;
            }
            let Some(deadline) = request["expiresAt"]
                .as_i64()
                .filter(|deadline| *deadline <= Utc::now().timestamp_millis() + 10_000)
            else {
                continue;
            };
            // An elapsed response deadline refuses new work. A committed live hold
            // is retained until its caller withdraws it after unlink/failure.
            if deadline <= Utc::now().timestamp_millis() {
                if receipt
                    .as_ref()
                    .is_none_or(|receipt| receipt["state"] != "committed")
                {
                    remove_missing_ok(&path)?;
                    remove_missing_ok(&response_path)?;
                }
                continue;
            }
            let action = request["action"].as_str().unwrap();
            let instance = identity.unwrap();
            let owner = json!({"pid":pid,"instance":instance});
            let result = if action == "commit" && requested_instance != Some(instance.as_str()) {
                Err("交付固定进程实例不匹配。".to_owned())
            } else {
                self.diagnostic_pin_owned(action, &pin_id, "delivery", Some(owner))
            };
            let mut response = json!({"schema":"mizar-host-delivery-response/1","pinId":pin_id,"requestId":request["requestId"],"ownerPid":pid,"ownerInstance":instance});
            if let Err(error) = result {
                response["error"] = json!(error.chars().take(512).collect::<String>());
            }
            write_delivery_json(&response_path, &response)?;
        }
        Ok(())
    }

    /// Scope synchronous native work only; async/spawned work must enter its own scope.
    pub fn with_task<T>(
        &self,
        task_id: Option<&str>,
        operation_id: Option<&str>,
        trigger: Option<&str>,
        run: impl FnOnce() -> T,
    ) -> T {
        self.with_task_attempt(task_id, operation_id, None, None, trigger, run)
    }

    pub fn with_task_attempt<T>(
        &self,
        task_id: Option<&str>,
        operation_id: Option<&str>,
        parent_operation_id: Option<&str>,
        attempt_id: Option<&str>,
        trigger: Option<&str>,
        run: impl FnOnce() -> T,
    ) -> T {
        let task_id = diagnostic_uuid(task_id);
        let context = json!({"taskId":task_id,"operationId":diagnostic_uuid(operation_id),"parentOperationId":diagnostic_uuid(parent_operation_id),"attemptId":diagnostic_uuid(attempt_id),"trigger":if task_id.is_some() { match trigger { Some("user") => "user", Some("system") => "system", _ => "unattributed" } } else {"unattributed"}});
        let _guard = TaskContextGuard(TASK_CONTEXT.with(|slot| slot.replace(context)));
        run()
    }

    /// Add a synchronous child attempt while preserving the current task and operation.
    pub fn with_attempt<T>(&self, attempt_id: Option<&str>, run: impl FnOnce() -> T) -> T {
        let mut context = TASK_CONTEXT.with(|slot| slot.borrow().clone());
        if !context.is_object() {
            context = json!({});
        }
        context["attemptId"] = json!(diagnostic_uuid(attempt_id));
        let _guard = TaskContextGuard(TASK_CONTEXT.with(|slot| slot.replace(context)));
        run()
    }

    pub fn event(&self, stage: &str, result: &str, detail: Option<&str>) {
        let observed = Utc::now();
        let observed_at = observed.to_rfc3339_opts(SecondsFormat::Millis, true);
        let observed_ms = observed.timestamp_millis().max(0) as u64;
        let monotonic_ms = self.started.elapsed().as_millis();
        let input_bytes = stage
            .len()
            .saturating_add(result.len())
            .saturating_add(detail.map_or(0, str::len));
        match self.inner.try_lock() {
            Ok(mut log) => {
                if let Err(error) = Self::write_locked(
                    &mut log,
                    stage,
                    result,
                    detail,
                    false,
                    Some((&observed_at, monotonic_ms)),
                ) {
                    self.note_deferred_loss(&self.deferred.failed, input_bytes, observed_ms);
                    eprintln!("桌面日志写入失败：{error}");
                }
            }
            Err(TryLockError::WouldBlock) => {
                // Do not wait behind a pin's metadata I/O on the native invoke
                // thread. Preserve a bounded original plus its event-time context.
                let bytes = stage
                    .len()
                    .saturating_add(result.len())
                    .saturating_add(detail.map_or(0, str::len))
                    .saturating_add(1024);
                if bytes > 128 * 1024 {
                    self.note_deferred_loss(&self.deferred.overflow, input_bytes, observed_ms);
                    return;
                }
                let Ok(mut queue) = self.deferred.queue.try_lock() else {
                    self.note_deferred_loss(&self.deferred.contended, input_bytes, observed_ms);
                    return;
                };
                if queue.entries.len() >= DEFERRED_LOG_EVENTS
                    || queue.bytes + bytes > DEFERRED_LOG_BYTES
                {
                    self.note_deferred_loss(&self.deferred.overflow, input_bytes, observed_ms);
                    return;
                }
                queue.bytes += bytes;
                queue.entries.push_back(DeferredEvent {
                    stage: stage.to_owned(),
                    result: result.to_owned(),
                    detail: detail.map(str::to_owned),
                    context: TASK_CONTEXT.with(|slot| slot.borrow().clone()),
                    observed_at,
                    monotonic_ms,
                    bytes,
                });
            }
            Err(TryLockError::Poisoned(_)) => {
                self.note_deferred_loss(&self.deferred.failed, input_bytes, observed_ms);
            }
        }
    }

    fn note_deferred_loss(&self, reason: &AtomicU64, bytes: usize, observed_ms: u64) {
        let mut first = self.deferred.first_lost_ms.load(Ordering::Relaxed);
        while first == 0 || observed_ms < first {
            match self.deferred.first_lost_ms.compare_exchange_weak(
                first,
                observed_ms,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(value) => first = value,
            }
        }
        self.deferred
            .last_lost_ms
            .fetch_max(observed_ms, Ordering::Relaxed);
        add_count(&self.deferred.lost_bytes, bytes as u64);
        add_count(&self.deferred.total_lost, 1);
        add_count(reason, 1);
    }

    fn deferred_source_state(&self) -> Value {
        let as_of = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let pending = self
            .deferred
            .queue
            .try_lock()
            .ok()
            .map(|queue| (queue.entries.len(), queue.bytes));
        let timestamp = |value: u64| {
            if value == 0 {
                None
            } else {
                chrono::DateTime::from_timestamp_millis(value as i64)
                    .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
            }
        };
        json!({"asOf":as_of,
            "memoryOnly":{"included":false,"events":pending.map(|value| value.0),"bytes":pending.map(|value| value.1),"reason":"not-durably-committed"},
            "unreportedLoss":{"overflow":self.deferred.overflow.load(Ordering::Relaxed),"contended":self.deferred.contended.load(Ordering::Relaxed),"writeFailed":self.deferred.failed.load(Ordering::Relaxed)},
            "lossTotals":{"reason":"native_event_loss_cumulative","count":self.deferred.total_lost.load(Ordering::Relaxed),"bytes":self.deferred.lost_bytes.load(Ordering::Relaxed),"firstObservedAt":timestamp(self.deferred.first_lost_ms.load(Ordering::Relaxed)),"lastObservedAt":timestamp(self.deferred.last_lost_ms.load(Ordering::Relaxed))}})
    }

    fn drain_deferred(&self) -> io::Result<()> {
        let mut log = match self.inner.try_lock() {
            Ok(log) => log,
            Err(TryLockError::WouldBlock) => return Ok(()),
            Err(TryLockError::Poisoned(_)) => {
                return Err(io::Error::other("desktop log lock unavailable"))
            }
        };
        let counts = [
            self.deferred.overflow.swap(0, Ordering::Relaxed),
            self.deferred.contended.swap(0, Ordering::Relaxed),
            self.deferred.failed.swap(0, Ordering::Relaxed),
        ];
        if counts.iter().any(|count| *count > 0) {
            let timestamp = |value: u64| {
                chrono::DateTime::from_timestamp_millis(value as i64)
                    .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
            };
            // count/bytes/range are cumulative for this Host run; dropped is the
            // new loss since the previous gap. Use already-approved projection
            // fields so cloud/support evidence cannot silently erase the gap.
            let detail = json!({"reason":"native_event_loss_cumulative","failureKind":"diagnostic_io","count":self.deferred.total_lost.load(Ordering::Relaxed),"dropped":counts.iter().fold(0u64, |sum,count| sum.saturating_add(*count)),"bytes":self.deferred.lost_bytes.load(Ordering::Relaxed),"firstObservedAt":timestamp(self.deferred.first_lost_ms.load(Ordering::Relaxed)),"lastObservedAt":timestamp(self.deferred.last_lost_ms.load(Ordering::Relaxed)),"bufferOverflow":counts[0],"bufferContended":counts[1],"writeFailed":counts[2]}).to_string();
            if let Err(error) = Self::write_locked(
                &mut log,
                "native_diagnostic_coverage_gap",
                "unconfirmed",
                Some(&detail),
                false,
                None,
            ) {
                add_count(&self.deferred.overflow, counts[0]);
                add_count(&self.deferred.contended, counts[1]);
                add_count(&self.deferred.failed, counts[2]);
                return Err(error);
            }
        }
        // The queue lock is never held during disk I/O. A failed write keeps the
        // original at the head for retry; ordinary callers remain non-blocking.
        for _ in 0..16 {
            let event = self
                .deferred
                .queue
                .lock()
                .map_err(|_| io::Error::other("deferred log lock unavailable"))?
                .entries
                .front()
                .cloned();
            let Some(event) = event else { break };
            let _context =
                TaskContextGuard(TASK_CONTEXT.with(|slot| slot.replace(event.context.clone())));
            Self::write_locked(
                &mut log,
                &event.stage,
                &event.result,
                event.detail.as_deref(),
                false,
                Some((&event.observed_at, event.monotonic_ms)),
            )?;
            let mut queue = self
                .deferred
                .queue
                .lock()
                .map_err(|_| io::Error::other("deferred log lock unavailable"))?;
            queue.entries.pop_front();
            queue.bytes = queue.bytes.saturating_sub(event.bytes);
        }
        Ok(())
    }

    pub fn step<T, E: std::fmt::Display + std::fmt::Debug>(
        &self,
        stage: &str,
        operation: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, String> {
        self.event(stage, "begin", None);
        match operation() {
            Ok(value) => {
                self.event(stage, "success", None);
                Ok(value)
            }
            Err(error) => {
                let message = format!("{error}\n{error:?}");
                self.event(stage, "failure", Some(&message));
                Err(format!("{stage}: {message}"))
            }
        }
    }

    pub fn preserve_error<E: std::fmt::Debug, T>(
        &self,
        command: &str,
        operation_id: Option<&str>,
        error: &E,
        friendly: T,
    ) -> T {
        self.event(
            "native_error",
            "failure",
            Some(
                &json!({"command":command,"operationId":operation_id,"cause":format!("{error:?}")})
                    .to_string(),
            ),
        );
        friendly
    }

    pub fn native_outcome<T: std::fmt::Debug, E: std::fmt::Debug>(
        &self,
        command: &str,
        operation_id: Option<&str>,
        result: &Result<T, E>,
    ) {
        self.event("native_command", if result.is_ok() { "success" } else { "failure" }, Some(&json!({"command":command,"operationId":operation_id,"outcome":format!("{result:?}")}).to_string()));
    }

    pub fn install_panic_hook(&self) {
        let logger = self.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let current = std::thread::current();
            // A panic inside the logger must not deadlock on its own mutex.
            if let Ok(mut log) = logger.inner.try_lock() {
                let _ = Self::write_entry(
                    &mut log,
                    "panic",
                    "failure",
                    Some(&format!(
                        "thread={:?}; {info}\n{}",
                        current.name(),
                        std::backtrace::Backtrace::force_capture()
                    )),
                    false,
                    None,
                );
            }
            previous(info);
        }));
    }
}
