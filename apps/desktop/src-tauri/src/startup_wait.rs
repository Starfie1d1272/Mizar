use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};

const VERIFY_TIMEOUT: Duration = Duration::from_secs(120);
const RUNTIME_TIMEOUT: Duration = Duration::from_secs(35);
const PROGRESS_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub struct Progress {
    pub verified: bool,
    pub completed: Option<u64>,
    pub total: Option<u64>,
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
        match entry["stage"].as_str() {
            Some("artifact_verified") => progress.verified = true,
            Some("artifact_verify_progress") => {
                progress.completed = entry["completed"].as_u64();
                progress.total = entry["total"].as_u64();
            }
            Some("supervisor_error") => progress.error = entry["error"].as_str().map(str::to_owned),
            _ => (),
        }
    }
    progress
}

pub struct StartupWait {
    deadline: Instant,
    verified: bool,
}
impl StartupWait {
    pub fn new(now: Instant) -> Self {
        Self {
            deadline: now + VERIFY_TIMEOUT,
            verified: false,
        }
    }
    pub fn update(&mut self, now: Instant, progress: &Progress) {
        if progress.verified && !self.verified {
            self.verified = true;
            self.deadline = now + RUNTIME_TIMEOUT;
        }
    }
    pub fn expired(&self, now: Instant) -> bool {
        now >= self.deadline
    }
    pub fn timeout_message(&self, progress: &Progress) -> String {
        if self.verified {
            "制播服务启动超时；请查看 state/logs/companion.stderr.log。".into()
        } else {
            let detail = match (progress.completed, progress.total) {
                (Some(completed), Some(total)) => format!("（已校验 {completed}/{total} 个文件）"),
                _ => String::new(),
            };
            format!("程序文件校验超时{detail}；请查看 state/logs/supervisor.ndjson。")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_has_its_own_budget_and_runtime_gets_only_one_new_deadline() {
        let start = Instant::now();
        let mut wait = StartupWait::new(start);
        assert!(!wait.expired(start + Duration::from_secs(40)));
        assert!(wait.expired(start + Duration::from_secs(120)));
        let progress = Progress {
            verified: true,
            ..Progress::default()
        };
        wait.update(start + Duration::from_secs(50), &progress);
        assert!(!wait.expired(start + Duration::from_secs(84)));
        wait.update(start + Duration::from_secs(80), &progress);
        assert!(wait.expired(start + Duration::from_secs(85)));
        assert!(wait.timeout_message(&progress).contains("制播服务启动超时"));
    }
    #[test]
    fn progress_is_session_scoped_and_tolerates_partial_log_lines() {
        let path =
            std::env::temp_dir().join(format!("mizar-progress-{}.ndjson", std::process::id()));
        std::fs::write(&path, concat!(
            "{\"startupSessionId\":\"old\",\"stage\":\"artifact_verified\"}\n",
            "{\"startupSessionId\":\"current\",\"stage\":\"artifact_verify_progress\",\"completed\":40,\"total\":100}\n",
            "{\"startupSessionId\":\"old\",\"stage\":\"supervisor_error\",\"error\":\"old failure\"}\n",
            "{\"startupSessionId\":"
        )).unwrap();
        let progress = read_progress(&path, "current");
        assert!(!progress.verified);
        assert!(progress.error.is_none());
        assert_eq!(progress.completed, Some(40));
        assert!(StartupWait::new(Instant::now())
            .timeout_message(&progress)
            .contains("40/100"));
        std::fs::remove_file(path).unwrap();
    }
}
