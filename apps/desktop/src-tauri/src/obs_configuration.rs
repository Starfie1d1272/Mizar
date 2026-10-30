//! OBS configuration ownership. No process-name adoption and no unsafe quit messages.
use crate::startup_log::DesktopLog;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

struct State {
    child: Option<Child>,
    configuration_owned: bool,
    sessions: BTreeSet<String>,
    document: u64,
    feedback: Option<&'static str>,
}
impl State {
    fn synchronize_document(&mut self, document: u64) -> bool {
        if self.document == document {
            return false;
        }
        let abandoned_owned = self.configuration_owned;
        self.document = document;
        self.sessions.clear();
        self.configuration_owned = false;
        self.feedback = abandoned_owned.then_some(
            "OBS 配置页面已离开，未自动关闭 OBS。如仍在运行，请核对推流与录制后手动关闭。",
        );
        abandoned_owned
    }

    fn finish_session(&mut self, session: &str) -> &'static str {
        if !self.sessions.remove(session) {
            return "session_finished";
        }
        if !self.sessions.is_empty() {
            return "configuration_in_use";
        }
        // End ownership before any fallible process/status read. A retained instance
        // cannot be reacquired by a later configuration visit after an unknown result.
        if std::mem::replace(&mut self.configuration_owned, false) {
            "owned"
        } else {
            "not_owned"
        }
    }
}

static STATE: Mutex<State> = Mutex::new(State {
    child: None,
    configuration_owned: false,
    sessions: BTreeSet::new(),
    document: 0,
    feedback: None,
});
static DOCUMENT: AtomicU64 = AtomicU64::new(0);

/// Host calls this on Main document-start/destroy, without waiting for an old renderer.
/// The atomic change also invalidates requests already waiting for the launch lock.
pub fn document_changed(log: &DesktopLog) {
    DOCUMENT.fetch_add(1, Ordering::AcqRel);
    let log = log.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut state) = STATE.lock() {
            if state.synchronize_document(DOCUMENT.load(Ordering::Acquire)) {
                log.event("obs_configuration", "preserved", Some("document_changed"));
            }
        } else {
            log.event(
                "obs_configuration",
                "state_failed",
                Some("configuration_mutex_unavailable"),
            );
        }
    });
}

pub fn context(log: &DesktopLog) -> Result<Value, String> {
    let mut state = STATE.lock().map_err(|_| "OBS 配置状态未能确认。")?;
    if state.synchronize_document(DOCUMENT.load(Ordering::Acquire)) {
        log.event("obs_configuration", "preserved", Some("document_changed"));
    }
    Ok(
        json!({ "documentGeneration": state.document.to_string(), "message": state.feedback.unwrap_or("") }),
    )
}

fn synchronize_request(
    state: &mut State,
    session: Option<(&str, &str)>,
    log: &DesktopLog,
) -> Result<(), String> {
    let document = DOCUMENT.load(Ordering::Acquire);
    if state.synchronize_document(document) {
        log.event("obs_configuration", "preserved", Some("document_changed"));
    }
    if session.is_some_and(|(_, requested)| requested.parse::<u64>().ok() != Some(document)) {
        log.event("obs_configuration", "stale_begin", None);
        return Err("OBS 配置页面已变化，请重新进入配置。".into());
    }
    Ok(())
}

fn session_allowed(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn reap(state: &mut State, log: &DesktopLog) -> Result<(), String> {
    if let Some(child) = state.child.as_mut() {
        if child
            .try_wait()
            .map_err(|error| {
                log.event(
                    "obs_configuration",
                    "process_read_failed",
                    Some(&error.to_string()),
                );
                "OBS 实例状态未能确认。"
            })?
            .is_some()
        {
            state.child = None;
            state.configuration_owned = false;
        }
    }
    Ok(())
}

/// An explicit Open action transfers a configuration instance to user ownership.
pub fn launch(path: &str, session: Option<(&str, &str)>, log: &DesktopLog) -> Result<bool, String> {
    if session.is_some_and(|(id, _)| !session_allowed(id)) {
        return Err("OBS 配置会话无法识别。".into());
    }
    let mut state = STATE.lock().map_err(|_| "OBS 启动状态不可用。")?;
    synchronize_request(&mut state, session, log)?;
    reap(&mut state, log)?;
    let path = Path::new(path);
    if !crate::obs_executable_allowed(path) || !path.is_file() {
        return Err("未找到 OBS，请在设置中选择 obs64.exe。".into());
    }
    let already_running = if state.child.is_some() {
        true
    } else {
        let mut probe = crate::background_powershell();
        probe.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-Process -Name obs64 -ErrorAction SilentlyContinue).Count",
        ]);
        crate::powershell::run(probe, log, "OBS 进程检测", Duration::from_secs(10))?
            .trim()
            .parse::<u32>()
            .map_err(|error| {
                log.event(
                    "obs_configuration",
                    "process_count_parse_failed",
                    Some(&error.to_string()),
                );
                "无法检查 OBS 进程。"
            })?
            > 0
    };
    synchronize_request(&mut state, session, log)?;
    if !already_running {
        // Keep the original handle; never infer ownership from a subsequently reused PID.
        state.child = Some(
            Command::new(path)
                .current_dir(path.parent().ok_or("OBS 程序未能打开。")?)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| {
                    log.event(
                        "obs_configuration",
                        "launch_failed",
                        Some(&error.to_string()),
                    );
                    "OBS 程序未能打开。".to_string()
                })?,
        );
        state.configuration_owned = session.is_some();
    }
    synchronize_request(&mut state, session, log)?;
    if let Some((session, _)) = session {
        state.sessions.insert(session.to_owned());
    } else {
        state.configuration_owned = false;
    }
    log.event(
        "obs_configuration",
        "opened",
        Some(if state.configuration_owned {
            "owned_instance"
        } else {
            "existing_or_user_instance"
        }),
    );
    Ok(already_running)
}

fn preservation_reason(production: &Value, outputs: &Value) -> &'static str {
    match production.get("mode").and_then(Value::as_str) {
        Some("live" | "hidden") => return "production",
        Some("preparation") => (),
        _ => return "unconfirmed",
    }
    for kind in ["stream", "record"] {
        let output = &outputs[kind];
        if output["active"] == true
            || output["pending"].is_string()
            || matches!(
                output["phase"].as_str(),
                Some("starting" | "active" | "stopping" | "reconnecting" | "paused")
            )
        {
            return "output";
        }
        if output["active"] != false
            || output["phase"] != "idle"
            || output.get("pending") != Some(&Value::Null)
        {
            return "unconfirmed";
        }
    }
    // OBS WebSocket has no atomic quit-if-idle. WM_CLOSE can be deferred and its
    // output confirmation is configurable, so even an idle snapshot cannot authorize it.
    "safe_quit_unavailable"
}

fn outcome(reason: &str) -> Value {
    let message = match reason {
        "configuration_in_use" => "仍有 OBS 配置会话未结束，已保留。请在 OBS 中核对后手动关闭。",
        "production" => "OBS 正用于制作，已保留。结束制作后请在 OBS 中手动关闭。",
        "output" => "OBS 输出已启动或正在变化，已保留。停止推流与录制后请在 OBS 中手动关闭。",
        "unconfirmed" => "OBS 状态未能确认，已保留。请在 OBS 中核对推流与录制，再手动关闭。",
        "safe_quit_unavailable" => {
            "OBS 配置已结束。无法确认安全自动退出，已保留；请在 OBS 中手动关闭。"
        }
        _ => "",
    };
    json!({ "reason": reason, "message": message })
}

pub fn finish(session: &str, log: &DesktopLog) -> Result<Value, String> {
    if !session_allowed(session) {
        return Err("OBS 配置会话无法识别。".into());
    }
    let mut state = STATE.lock().map_err(|_| "OBS 启动状态不可用。")?;
    synchronize_request(&mut state, None, log)?;
    let session_result = state.finish_session(session);
    if session_result != "owned" {
        return Ok(outcome(session_result));
    }
    if reap(&mut state, log).is_err() {
        return Ok(outcome("unconfirmed"));
    }
    if state.child.is_none() {
        return Ok(outcome("not_owned"));
    }
    let mut probe = crate::background_powershell();
    probe.args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $p=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/local/v1/production' -TimeoutSec 3; $o=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/local/v1/obs/outputs' -TimeoutSec 3; @{production=$p;outputs=$o}|ConvertTo-Json -Depth 6 -Compress"]);
    let reason =
        match crate::powershell::run(probe, log, "OBS 配置状态检测", Duration::from_secs(8)) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => preservation_reason(&value["production"], &value["outputs"]),
                Err(error) => {
                    log.event(
                        "obs_configuration",
                        "status_parse_failed",
                        Some(&error.to_string()),
                    );
                    "unconfirmed"
                }
            },
            Err(_) => "unconfirmed",
        };
    log.event("obs_configuration", "preserved", Some(reason));
    Ok(outcome(reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn idle() -> Value {
        json!({"stream":{"active":false,"phase":"idle","pending":null},"record":{"active":false,"phase":"idle","pending":null}})
    }

    #[test]
    fn stale_begin_cannot_consume_current_document_sessions() {
        let document = DOCUMENT.load(Ordering::Acquire);
        let root = std::env::temp_dir().join(format!(
            "mizar-obs-document-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = DesktopLog::new(&root, Some(root.join("state"))).unwrap();
        let mut state = State {
            child: None,
            configuration_owned: true,
            sessions: BTreeSet::from(["current-document".into()]),
            document,
            feedback: None,
        };
        let old = document.wrapping_sub(1).to_string();
        assert!(synchronize_request(&mut state, Some(("old", &old)), &log).is_err());
        assert!(state.configuration_owned);
        assert!(state.sessions.contains("current-document"));
        assert!(!state.sessions.contains("old"));
        drop(log);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn idle_does_not_authorize_racy_close() {
        assert_eq!(
            preservation_reason(&json!({"mode":"preparation"}), &idle()),
            "safe_quit_unavailable"
        );
    }
    #[test]
    fn preserves_production_pending_and_unknown_outputs() {
        for mode in ["live", "hidden"] {
            assert_eq!(
                preservation_reason(&json!({"mode":mode}), &idle()),
                "production"
            );
        }
        for kind in ["stream", "record"] {
            for phase in ["starting", "active", "stopping", "reconnecting", "paused"] {
                let mut outputs = idle();
                outputs[kind]["phase"] = json!(phase);
                assert_eq!(
                    preservation_reason(&json!({"mode":"preparation"}), &outputs),
                    "output"
                );
            }
            let mut outputs = idle();
            outputs[kind]["pending"] = json!("start");
            assert_eq!(
                preservation_reason(&json!({"mode":"preparation"}), &outputs),
                "output"
            );
            outputs = idle();
            outputs[kind].as_object_mut().unwrap().remove("pending");
            assert_eq!(
                preservation_reason(&json!({"mode":"preparation"}), &outputs),
                "unconfirmed"
            );
            outputs[kind] = Value::Null;
            assert_eq!(
                preservation_reason(&json!({"mode":"preparation"}), &outputs),
                "unconfirmed"
            );
        }
        assert_eq!(preservation_reason(&Value::Null, &idle()), "unconfirmed");
    }
}
