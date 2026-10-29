use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

thread_local! {
    static TASK_CONTEXT: std::cell::RefCell<Value> = const { std::cell::RefCell::new(Value::Null) };
}
struct TaskContextGuard(Value);
impl Drop for TaskContextGuard {
    fn drop(&mut self) { TASK_CONTEXT.with(|slot| { slot.replace(self.0.take()); }); }
}
fn diagnostic_uuid(value: Option<&str>) -> Option<&str> {
    value.filter(|text| text.len() == 36 && text.bytes().enumerate().all(|(i, byte)| {
        if [8, 13, 18, 23].contains(&i) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    }))
}

pub const LOG_LIMIT: u64 = 25 * 1024 * 1024;
const HISTORY: usize = 3;
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
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "用户数据目录不可用。")
        })?)
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

fn rotated(directory: &Path, index: usize) -> PathBuf {
    directory.join(if index == 0 {
        "desktop.ndjson".into()
    } else {
        format!("desktop.{index}.ndjson")
    })
}

fn rotate(directory: &Path) -> io::Result<()> {
    let oldest = rotated(directory, HISTORY);
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (0..HISTORY).rev() {
        let source = rotated(directory, index);
        if source.exists() {
            fs::rename(source, rotated(directory, index + 1))?;
        }
    }
    Ok(())
}

fn credential_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    ["password", "passwd", "token", "secret", "credential", "authorization", "cookie", "streamkey", "apikey"].iter().any(|word| key.contains(word))
}

/// Preserve technical context while removing credentials embedded in text.
pub(crate) fn redact_text(text: &str) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(Bearer|Basic)\s+[^\s\"',}]+"#).unwrap());
    static COOKIE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?im)(\b(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]*").unwrap());
    static FIELD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b((?:[a-z0-9_-]*(?:password|passwd|token|secret|credential)|authorization|cookie|set-cookie|api[_-]?key|stream[_-]?key|ticket)[\"']?\s*[:=]\s*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;}&?#]+)"#).unwrap());
    static USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)([a-z][a-z0-9+.-]{0,31}://)[^/\s\"'<>@]+@"#).unwrap());
    static RTMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(rtmps?://[^/\s\"'<>]+/(?:[^/\s\"'<>]+/)+)[^/\s\"'<>?#]+"#).unwrap());
    static LOGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"rh_mizar_[a-zA-Z0-9_-]+").unwrap());
    let text = BEARER.replace_all(text, "$1 [redacted]");
    let text = COOKIE.replace_all(&text, "$1[redacted]");
    let text = FIELD.replace_all(&text, "$1[redacted]");
    let text = USERINFO.replace_all(&text, "$1[redacted]@");
    let text = RTMP.replace_all(&text, "$1[redacted]");
    LOGIN.replace_all(&text, "[redacted]").into_owned()
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(fields.into_iter().map(|(key, value)| {
            let value = if credential_key(&key) { json!("[redacted]") } else { redact_value(value) };
            (key, value)
        }).collect()),
        Value::Array(fields) => Value::Array(fields.into_iter().map(redact_value).collect()),
        Value::String(text) if text.starts_with("http://") || text.starts_with("https://") => {
            if let Some((path, query)) = text.split_once('?') {
                let query = query.split('&').map(|part| {
                    if let Some((key, value)) = part.split_once('=') {
                        format!("{key}={}", if credential_key(key) || ["code", "key", "auth"].contains(&key) { "[redacted]" } else { value })
                    } else { part.to_owned() }
                }).collect::<Vec<_>>().join("&");
                json!(redact_text(&format!("{path}?{query}")))
            } else { json!(redact_text(&text)) }
        },
        Value::String(text) => json!(redact_text(&text)),
        other => other,
    }
}

impl DesktopLog {
    pub fn new(root: &Path, state_override: Option<PathBuf>) -> io::Result<Self> {
        let state_root = writable_root(root, state_override)?;
        let directory = state_root.join("logs");
        fs::create_dir_all(&directory)?;
        rotate(&directory)?;
        let ticks = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let session_id = format!("{:032x}-{:08x}", ticks, std::process::id());
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
    pub fn committed_event(&self, stage: &str, result: &str, detail: Option<&str>) -> io::Result<()> {
        self.write_mode(stage, result, detail, true)
    }
    fn write_mode(&self, stage: &str, result: &str, detail: Option<&str>, durable: bool) -> io::Result<()> {
        let mut log = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("desktop log lock unavailable"))?;
        // Preserve each navigation in the full retained product log.
        if stage == "main_page_load" && result == "success" {
            log.page_loads = log.page_loads.saturating_add(1);

        }
        if let Some(detail) = detail {
            let clean = serde_json::from_str::<Value>(detail).map(redact_value).map(|value| value.to_string()).unwrap_or_else(|_| redact_text(detail));
            if clean.len() > MESSAGE_LIMIT {
                let mut chunks = Vec::new();
                let mut start = 0;
                while start < clean.len() {
                    let mut end = (start + MESSAGE_LIMIT).min(clean.len());
                    while !clean.is_char_boundary(end) { end -= 1; }
                    chunks.push(&clean[start..end]);
                    start = end;
                }
                let detail_id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
                for (index, text) in chunks.iter().enumerate() {
                    Self::write_entry(&log, stage, result, Some(&json!({"detailId":detail_id,"part":index + 1,"parts":chunks.len(),"text":text}).to_string()), durable)?;
                }
                return Ok(());
            }
            Self::write_entry(&log, stage, result, Some(&clean), durable)
        } else { Self::write_entry(&log, stage, result, None, durable) }
    }

    fn write_entry(
        log: &LogFile,
        stage: &str,
        result: &str,
        detail: Option<&str>,
        durable: bool,
    ) -> io::Result<()> {
        let mut entry = log.identity.clone();
        entry["trigger"] = json!("system");
        entry["taskId"] = Value::Null;
        entry["operationId"] = Value::Null;
        TASK_CONTEXT.with(|slot| {
            if let Value::Object(context) = &*slot.borrow() {
                for (key, value) in context { entry[key] = value.clone(); }
            }
        });
        entry["time"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        entry["stage"] = json!(stage);
        entry["result"] = json!(result);
        if let Some(detail) = detail {
            entry[if result == "failure" {
                "error"
            } else {
                "detail"
            }] = json!(serde_json::from_str::<Value>(detail).map(redact_value).map(|value| value.to_string()).unwrap_or_else(|_| redact_text(detail)));
        }
        if stage == "main_page_load" && result == "success" {
            entry["occurrences"] = json!(1);
        }
        let mut bytes = serde_json::to_vec(&entry)?;
        bytes.push(b'\n');
        let current = rotated(&log.directory, 0);
        if fs::metadata(&current).map_or(0, |m| m.len()) + bytes.len() as u64 > log.limit {
            rotate(&log.directory)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(current)?;
        file.write_all(&bytes)?;
        file.flush()?;
        if durable { file.sync_data()?; }
        Ok(())
    }

    /// Scope synchronous native work only; async/spawned work must enter its own scope.
    pub fn with_task<T>(&self, task_id: Option<&str>, operation_id: Option<&str>, trigger: Option<&str>, run: impl FnOnce() -> T) -> T {
        let task_id = diagnostic_uuid(task_id);
        let context = json!({"taskId":task_id,"operationId":diagnostic_uuid(operation_id),"trigger":if task_id.is_some() { match trigger { Some("user") => "user", Some("system") => "system", _ => "unattributed" } } else {"unattributed"}});
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

    pub fn preserve_error<E: std::fmt::Debug, T>(&self, command: &str, operation_id: Option<&str>, error: &E, friendly: T) -> T {
        self.event("native_error", "failure", Some(&json!({"command":command,"operationId":operation_id,"cause":format!("{error:?}")}).to_string()));
        friendly
    }

    pub fn native_outcome<T: std::fmt::Debug, E: std::fmt::Debug>(&self, command: &str, operation_id: Option<&str>, result: &Result<T, E>) {
        self.event("native_command", if result.is_ok() { "success" } else { "failure" }, Some(&json!({"command":command,"operationId":operation_id,"outcome":format!("{result:?}")}).to_string()));
    }

    pub fn install_panic_hook(&self) {
        let logger = self.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let current = std::thread::current();
            // A panic inside the logger must not deadlock on its own mutex.
            if let Ok(log) = logger.inner.try_lock() {
                let _ = Self::write_entry(
                    &log,
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
