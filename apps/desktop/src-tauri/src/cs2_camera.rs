//! Runtime operations for the native camera lease.
use crate::companion_http::{request, request_with_identity, runtime_token};
use crate::cs2_process::{cs2_pids, WorkspaceProcess};
use crate::startup_log::DesktopLog;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub fn camera_session(
    log: &DesktopLog,
    action: &str,
    lease: Option<&str>,
    revision: Option<&str>,
) -> Result<serde_json::Value, String> {
    let token = runtime_token(log)?;
    let mut body = serde_json::json!({"action": action, "host": log.session_id});
    if let Some(lease) = lease {
        body["lease"] = lease.into();
    }
    if let Some(revision) = revision {
        body[if action == "begin-demo" {
            "requestId"
        } else {
            "expectedRevision"
        }] = revision.into();
    }
    let (code, value) = request_with_identity(
        log,
        "POST",
        "/operator/runtime/camera-session",
        &body.to_string(),
        Instant::now() + Duration::from_secs(2),
        Some(&token),
    )?;
    if code != 200 || value["ok"] != true {
        if action == "begin" && code == 409 && value["notStarted"] == true {
            return Err("camera_not_started:运镜准备条件已变化，请重试。".into());
        }
        return Err("原生运镜会话已失效；请结束制作后重新借用。".into());
    }
    Ok(value)
}

pub fn disconnect_camera(log: &DesktopLog) -> Result<(), String> {
    let (code, camera) = request(
        log,
        "POST",
        "/operator/orchestration",
        r#"{"action":"disconnect"}"#,
        Instant::now() + Duration::from_secs(2),
    )?;
    // held is the operator's automatic/manual choice; disconnect preserves it.
    if code != 200 || camera["status"]["connected"] != false {
        return Err("旧运镜连接未能隔离，请检查本地服务；执行及停止均未确认。".into());
    }
    Ok(())
}

struct CameraLease {
    process: WorkspaceProcess,
    lease: String,
    invalidated: bool,
}
impl CameraLease {
    fn matches_running_game(&self, log: &crate::startup_log::DesktopLog) -> bool {
        self.process.is_running()
            && cs2_pids(log).is_ok_and(|pids| pids.as_slice() == [self.process.pid])
    }
}

#[derive(Clone, Default)]
pub(crate) struct CameraLeaseState(Arc<Mutex<Option<CameraLease>>>);

impl CameraLeaseState {
    pub(crate) fn bind(
        &self,
        process: WorkspaceProcess,
        lease: String,
        log: &DesktopLog,
    ) -> Result<(), String> {
        if !process.is_running() || cs2_pids(log)? != vec![process.pid] {
            return Err("游戏状态已经变化，运镜连接没有绑定。请重试。".into());
        }
        *self.0.lock().map_err(|_| "运镜会话状态不可用。")? = Some(CameraLease {
            process,
            lease,
            invalidated: false,
        });
        Ok(())
    }

    pub(crate) fn ready(&self, log: &DesktopLog) -> bool {
        self.0.lock().is_ok_and(|state| {
            state
                .as_ref()
                .is_some_and(|camera| !camera.invalidated && camera.matches_running_game(log))
        })
    }

    pub(crate) fn current(&self, log: &DesktopLog) -> Option<(String, bool)> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let camera = state.as_mut()?;
        if !camera.invalidated && !camera.matches_running_game(log) {
            camera.invalidated = true;
        }
        Some((camera.lease.clone(), camera.invalidated))
    }

    pub(crate) fn invalidate(&self) {
        if let Some(camera) = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_mut()
        {
            camera.invalidated = true;
        }
    }

    pub(crate) fn clear(&self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }

    /// Serialize renewal with revocation. This lock never acquires ManagedCs2.
    pub(crate) fn pulse(&self, log: &DesktopLog) {
        let mut state = match self.0.lock() {
            Ok(state) => state,
            Err(error) => {
                if let Some(camera) = error.into_inner().as_mut() {
                    camera.invalidated = true;
                }
                return;
            }
        };
        let Some(camera) = state.as_mut() else {
            return;
        };
        if camera.invalidated {
            return;
        }
        let result = if camera.matches_running_game(log) {
            camera_session(log, "pulse", Some(&camera.lease), None)
        } else {
            Err("当前游戏状态已经变化。请重新检查游戏后重试。".into())
        };
        if let Err(error) = result {
            camera.invalidated = true;
            let retired = camera_session(log, "invalidate", Some(&camera.lease), None).is_ok();
            if retired {
                *state = None;
            }
            log.event("managed_camera_isolation", "failure", Some(&error));
        }
    }
}
