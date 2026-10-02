use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub const LOG_LIMIT: u64 = 256 * 1024;
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
    let state = normalized(&override_path.unwrap_or_else(|| root.join("state")));
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

fn bounded(text: &str) -> String {
    if text.len() <= MESSAGE_LIMIT {
        return text.into();
    }
    let mut end = MESSAGE_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} [truncated]", &text[..end])
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
            })),
            directory,
            state_root,
            session_id,
        };
        logger.write("process_start", "success", None)?;
        Ok(logger)
    }

    fn write(&self, stage: &str, result: &str, detail: Option<&str>) -> io::Result<()> {
        let log = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("desktop log lock unavailable"))?;
        Self::write_entry(&log, stage, result, detail)
    }

    fn write_entry(
        log: &LogFile,
        stage: &str,
        result: &str,
        detail: Option<&str>,
    ) -> io::Result<()> {
        let mut entry = log.identity.clone();
        entry["time"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        entry["stage"] = json!(stage);
        entry["result"] = json!(result);
        if let Some(detail) = detail {
            entry[if result == "failure" {
                "error"
            } else {
                "detail"
            }] = json!(bounded(detail));
        }
        let mut bytes = serde_json::to_vec(&entry)?;
        bytes.push(b'\n');
        let current = rotated(&log.directory, 0);
        if fs::metadata(&current).map_or(0, |m| m.len()) + bytes.len() as u64 > LOG_LIMIT {
            rotate(&log.directory)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(current)?;
        file.write_all(&bytes)?;
        file.flush()
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
                );
            }
            previous(info);
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mizar-desktop-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(path.join("resources/metadata")).unwrap();
        path
    }

    #[test]
    fn logs_failed_stage_and_artifact_identity_and_preserves_previous_session() {
        let root = root("sessions");
        fs::write(root.join("resources/metadata/artifact.json"), json!({ "gitSha": "a".repeat(40), "artifactSha256": "b".repeat(64), "token": "never-copy-this" }).to_string()).unwrap();
        let first = DesktopLog::new(&root, None).unwrap();
        let failure = first.step("main_window", || {
            Err::<(), _>(io::Error::other("HRESULT: 0x80004005"))
        });
        assert!(failure.unwrap_err().contains("HRESULT"));
        let second = DesktopLog::new(&root, None).unwrap();
        assert_ne!(first.session_id, second.session_id);
        let history = fs::read_to_string(rotated(&second.directory, 1)).unwrap();
        assert!(history.contains("main_window") && history.contains("0x80004005"));
        assert!(history.contains(&"a".repeat(40)) && !history.contains("never-copy-this"));
        for line in history.lines() {
            let value: Value = serde_json::from_str(line).unwrap();
            assert!(value["time"].as_str().unwrap().ends_with('Z'));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounds_utf8_entries_total_files_and_preserves_parseable_ndjson() {
        let root = root("bounds");
        let log = DesktopLog::new(&root, None).unwrap();
        for _ in 0..200 {
            log.event("failure_fixture", "failure", Some(&"错误".repeat(9000)));
        }
        let files: Vec<_> = fs::read_dir(&log.directory)
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(files.len(), HISTORY + 1);
        for file in files {
            assert!(file.metadata().unwrap().len() <= LOG_LIMIT);
            for line in fs::read_to_string(file.path()).unwrap().lines() {
                serde_json::from_str::<Value>(line).unwrap();
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_relative_and_normalized_payload_state_paths() {
        let root = root("state");
        assert!(writable_root(&root, Some(PathBuf::from("relative"))).is_err());
        assert!(writable_root(&root, Some(root.join("state/../resources/logs"))).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
