//! OBS configuration ownership. No process-name adoption and no unsafe quit messages.
use crate::startup_log::DesktopLog;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

struct State {
    child: Option<Child>,
    configuration_owned: bool,
    sessions: BTreeSet<String>,
}
impl State {
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
});

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
pub fn launch(path: &str, session: Option<&str>, log: &DesktopLog) -> Result<bool, String> {
    if session.is_some_and(|id| !session_allowed(id)) {
        return Err("OBS 配置会话无法识别。".into());
    }
    let mut state = STATE.lock().map_err(|_| "OBS 启动状态不可用。")?;
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
    if let Some(session) = session {
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
    fn ending_last_session_releases_ownership_before_fallible_reads_and_later_visits() {
        let mut state = State {
            child: None,
            configuration_owned: true,
            sessions: BTreeSet::from(["first".into()]),
        };
        assert_eq!(state.finish_session("first"), "owned");
        assert!(!state.configuration_owned);
        // A failed status probe must not leave permission to acquire this retained instance.
        state.sessions.insert("later".into());
        assert_eq!(state.finish_session("first"), "session_finished");
        assert_eq!(state.finish_session("later"), "not_owned");
    }
    #[test]
    fn an_old_session_cannot_end_ownership_while_a_newer_session_is_unfinished() {
        let mut state = State {
            child: None,
            configuration_owned: true,
            sessions: BTreeSet::from(["old".into(), "new".into()]),
        };
        assert_eq!(state.finish_session("old"), "configuration_in_use");
        assert!(state.configuration_owned);
        assert_eq!(state.finish_session("old"), "session_finished");
        assert!(state.configuration_owned);
        assert_eq!(state.finish_session("new"), "owned");
        assert!(!state.configuration_owned);
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
    #[test]
    fn accepts_only_bounded_session_ids() {
        assert!(session_allowed("00000000-0000-4000-8000-000000000001"));
        for id in [
            "",
            "obs64",
            "../session",
            "00000000-0000-4000-8000-00000000000z",
        ] {
            assert!(!session_allowed(id));
        }
    }
}
