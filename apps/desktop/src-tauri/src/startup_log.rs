use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
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
    pub directory: PathBuf,
    pub state_root: PathBuf,
    pub session_id: String,
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
    write_poisoned: bool,
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
                write_poisoned: false,
            })),
            directory,
            state_root,
            session_id,
        };
        logger.write("process_start", "success", None)?;
        Ok(logger)
    }

    fn write(&self, stage: &str, result: &str, detail: Option<&str>) -> io::Result<()> {
        self.write_mode(stage, result, detail, false)
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
        let mut log = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("desktop log lock unavailable"))?;
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
                    Self::write_entry(&mut log, stage, result, Some(&json!({"detailId":detail_id,"part":index + 1,"parts":chunks.len(),"text":text}).to_string()), durable)?;
                }
                return Ok(());
            }
            Self::write_entry(&mut log, stage, result, Some(&clean), durable)
        } else {
            Self::write_entry(&mut log, stage, result, None, durable)
        }
    }

    fn write_entry(
        log: &mut LogFile,
        stage: &str,
        result: &str,
        detail: Option<&str>,
        durable: bool,
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
        entry["monotonicMs"] = Value::Null;
        entry["sourceInterval"] = Value::Null;
        entry["coverage"] = json!({"durability":"committed","unknown":["cross-process-clock-order"],"excluded":[],"replayCount":0,"occurrences":1});
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
        entry["time"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        entry["observedAt"] = entry["time"].clone();
        entry["recordedAt"] = entry["time"].clone();
        entry["stage"] = json!(stage);
        entry["result"] = json!(result);
        entry["evidence"] = detail
            .map(|text| {
                serde_json::from_str::<Value>(text)
                    .map(redact_value)
                    .unwrap_or_else(|_| json!({"text":redact_text(text)}))
            })
            .unwrap_or(Value::Null);
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
            Self::collect_segments(&log, bytes.len() as u64).map_err(|e| e.to_string())?;
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
            Self::collect_segments(&log, LOG_LIMIT).map_err(|e| e.to_string())?;
        }
        append_committed(&mut log, &path, &bytes).map_err(|e| e.to_string())?;
        Ok(json!({"eventIds":ids}))
    }

    fn collect_segments(log: &LogFile, incoming: u64) -> io::Result<()> {
        use std::collections::HashSet;
        let mut protected: HashSet<String> = log.active_segments.iter().cloned().collect();
        protected.insert(log.segment_name.clone());
        protected.insert(log.document_segment_name.clone());
        let mut extra = HashSet::new();
        let pins = log.directory.join("host-pins");
        if pins.exists() {
            for entry in fs::read_dir(&pins)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !(name.ends_with(".json") || name.ends_with(".partial")) {
                    continue;
                }
                let meta = fs::symlink_metadata(entry.path())?;
                if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
                    return Err(io::Error::other("unsafe host pin"));
                }
                let receipt: Value = serde_json::from_slice(&fs::read(entry.path())?)?;
                if receipt["expiresAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|t| t < Utc::now())
                {
                    continue;
                }
                for segment in receipt["segments"]
                    .as_array()
                    .ok_or_else(|| io::Error::other("invalid host pin"))?
                {
                    let name = segment["name"]
                        .as_str()
                        .ok_or_else(|| io::Error::other("invalid host pin name"))?;
                    protected.insert(name.to_owned());
                    if receipt["kind"] == "incident" && receipt["state"] == "committed" {
                        extra.insert(name.to_owned());
                    }
                }
            }
        }
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
            if protected.contains(&name) {
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
            return Err(io::Error::other("host pinned retention budget"));
        }
        Ok(())
    }

    /// Prepare/commit/release only this producer's evidence, in its writer serial section.
    pub fn diagnostic_pin(&self, action: &str, pin_id: &str, kind: &str) -> Result<Value, String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        if diagnostic_uuid(Some(pin_id)).is_none()
            || !["incident", "export", "delivery", "active"].contains(&kind)
            || !["prepare", "commit", "release"].contains(&action)
        {
            return Err("诊断固定请求无效。".into());
        }
        let mut log = self.inner.lock().map_err(|_| "诊断写入锁不可用。")?;
        let directory = self.directory.join("host-pins");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("诊断固定路径无效。".into());
        }
        let path = directory.join(format!("{pin_id}.json"));
        if action == "prepare" && path.exists() {
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > 1024 * 1024
            {
                return Err("诊断固定回执无效。".into());
            }
            let previous: Value =
                serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if previous["pinId"] != pin_id || previous["kind"] != kind {
                return Err("诊断固定回执不匹配。".into());
            }
            return Ok(previous);
        }
        if action == "release" {
            match fs::remove_file(&path) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.to_string()),
            };
            return Ok(json!({"pinId":pin_id,"state":"released"}));
        }
        let mut receipt = if action == "prepare" {
            let mut segments = Vec::new();
            for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !(name.starts_with("desktop-") || name.starts_with("document-"))
                    || !name.ends_with(".ndjson")
                {
                    continue;
                }
                let before = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
                if !before.is_file() || before.file_type().is_symlink() {
                    return Err("诊断固定源无效。".into());
                }
                let mut file = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
                let mut hash = Sha256::new();
                let mut size = 0u64;
                let mut buffer = [0u8; 65536];
                loop {
                    let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    size += n as u64;
                    hash.update(&buffer[..n]);
                }
                if size != before.len() {
                    return Err("诊断固定源已变化。".into());
                }
                segments.push(
                    json!({"name":name,"bytes":size,"sha256":format!("{:x}",hash.finalize())}),
                );
            }
            // Seal both live carriers. Their names are never reused after receipt publication.
            let next_host =
                reserve_segment(&log.directory, "desktop").map_err(|e| e.to_string())?;
            let next_document =
                reserve_segment(&log.directory, "document").map_err(|e| e.to_string())?;
            let sealed = log.segment_name.clone();
            log.active_segments.push(sealed);
            let sealed_document = log.document_segment_name.clone();
            log.active_segments.push(sealed_document);
            log.segment_name = next_host;
            log.document_segment_name = next_document;
            json!({"schema":"mizar-producer-pin/2","pinId":pin_id,"producerKind":"host","producerRunId":self.session_id,"kind":kind,"state":"prepared","expiresAt":(Utc::now()+chrono::Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Millis,true),"segments":segments})
        } else {
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
                return Err("诊断固定回执无效。".into());
            }
            let receipt: Value =
                serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if receipt["schema"] != "mizar-producer-pin/2"
                || receipt["pinId"] != pin_id
                || receipt["kind"] != kind
            {
                return Err("诊断固定回执不匹配。".into());
            }
            receipt
        };
        if action == "commit" {
            if receipt["expiresAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|time| time <= Utc::now())
            {
                return Err("诊断固定租约已到期，请重新固定。".into());
            }
            for segment in receipt["segments"].as_array().ok_or("固定范围无效。")? {
                let name = segment["name"].as_str().ok_or("固定文件无效。")?;
                if name.contains(['/', '\\'])
                    || !(name.starts_with("desktop-") || name.starts_with("document-"))
                    || !name.ends_with(".ndjson")
                {
                    return Err("固定文件路径无效。".into());
                }
                let path = self.directory.join(name);
                let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                if !meta.is_file()
                    || meta.file_type().is_symlink()
                    || meta.len() != segment["bytes"].as_u64().ok_or("固定大小无效。")?
                {
                    return Err("固定文件已变化。".into());
                }
                let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
                let mut hash = Sha256::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    hash.update(&buffer[..n]);
                }
                if segment["sha256"] != format!("{:x}", hash.finalize()) {
                    return Err("固定文件摘要不匹配。".into());
                }
            }
        }
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
            if kind != "export" {
                receipt["expiresAt"] = Value::Null;
            }
        }
        let temporary = directory.join(format!("{pin_id}.partial"));
        if let Ok(meta) = fs::symlink_metadata(&temporary) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("诊断固定暂存路径无效。".into());
            }
            fs::remove_file(&temporary).map_err(|e| e.to_string())?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&receipt).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        fs::rename(temporary, path).map_err(|e| e.to_string())?;
        Ok(receipt)
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
        if let Err(error) = self.write(stage, result, detail) {
            eprintln!("桌面日志写入失败：{error}");
        }
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
                );
            }
            previous(info);
        }));
    }
}
