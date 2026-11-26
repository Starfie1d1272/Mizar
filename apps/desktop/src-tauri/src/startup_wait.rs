use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};

const RUNTIME_TIMEOUT: Duration = Duration::from_secs(35);
const PROGRESS_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub struct Progress {
    pub error: Option<String>,
}

pub fn read_progress(path: &Path, session_id: &str) -> Progress {
    let mut progress = Progress::default();
    let Ok(mut file) = File::open(path) else {
        return progress;
    };
    let Ok(metadata) = file.metadata() else {
        return progress;
    };
    if file
        .seek(SeekFrom::Start(
            metadata.len().saturating_sub(PROGRESS_BYTES),
        ))
        .is_err()
    {
        return progress;
    }
    let mut bytes = Vec::new();
    if file.take(PROGRESS_BYTES).read_to_end(&mut bytes).is_err() {
        return progress;
    }
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["startupSessionId"].as_str() != Some(session_id) {
            continue;
        }
        if entry["stage"].as_str() == Some("supervisor_error") {
            progress.error = entry["error"].as_str().map(str::to_owned);
        }
    }
    progress
}

pub struct StartupWait {
    deadline: Instant,
}
impl StartupWait {
    pub fn new(now: Instant) -> Self {
        Self {
            deadline: now + RUNTIME_TIMEOUT,
        }
    }
    pub fn expired(&self, now: Instant) -> bool {
        now >= self.deadline
    }
    pub fn timeout_message(&self) -> String {
        "制播服务启动超时；请查看 state/logs/companion.stderr.log。".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn expires_after_single_runtime_timeout() {
        let start = Instant::now();
        let wait = StartupWait::new(start);
        assert!(!wait.expired(start + Duration::from_secs(34)));
        assert!(wait.expired(start + Duration::from_secs(35)));
        assert_eq!(
            wait.timeout_message(),
            "制播服务启动超时；请查看 state/logs/companion.stderr.log。"
        );
    }

    #[test]
    fn read_progress_extracts_matching_supervisor_error() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mizar-startup-wait-{nonce}.ndjson"));
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"startupSessionId":"other","stage":"supervisor_error","error":"wrong session"}}"#
        )
        .unwrap();
        writeln!(file, "not-json").unwrap();
        writeln!(
            file,
            r#"{{"startupSessionId":"target","stage":"process_start"}}"#
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"startupSessionId":"target","stage":"supervisor_error","error":"real error"}}"#
        )
        .unwrap();

        let progress = read_progress(&path, "target");
        let _ = std::fs::remove_file(&path);
        assert_eq!(progress.error.as_deref(), Some("real error"));
    }
}
