//! Versioned durable session data. Launch transitions preserve the original wire format.
use crate::cs2_config_identity::SessionIdentity;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GsiSource {
    pub ticket: String,
    pub source_id: String,
    pub cfg_path: String,
    pub original_hash: String,
    pub applied_hash: String,
    #[serde(default)]
    pub committed: bool,
    #[serde(flatten)]
    extra: Map<String, Value>,
}
impl GsiSource {
    pub(crate) fn prepared(
        ticket: &str,
        source_id: &str,
        cfg_path: String,
        original_hash: String,
        applied_hash: String,
    ) -> Self {
        Self {
            ticket: ticket.into(),
            source_id: source_id.into(),
            cfg_path,
            original_hash,
            applied_hash,
            committed: false,
            extra: Map::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchPhase {
    Prepared,
    Submitted,
    Bound,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    version: u32,
    pub video: String,
    pub executable: String,
    #[serde(default)]
    launch_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_cancelled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    launch_time: Option<u64>,
    pid: Option<u32>,
    created: Option<u64>,
    #[serde(default)]
    pub preserve_settings: bool,
    #[serde(default)]
    pub full_snapshot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_write_attempted: Option<bool>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mulnx_launch: bool,
    #[serde(default)]
    pub spectator_cfg: bool,
    #[serde(default)]
    pub native_hud_toggle: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_rate_limit: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_rate_files: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demo_test_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spectator_warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_recovery_warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demo_playback_cfg_error: Option<String>,
    // These payloads belong to their file-format owners, which validate them before use.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub demo_playback_cfg: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub console_diagnostics: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub console_diagnostics_warning: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gsi_source: Option<GsiSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_source_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_cancel_ticket: Option<String>,
    // Retain version-specific recovery evidence and extensions across launch updates.
    #[serde(flatten)]
    recovery: Map<String, Value>,
}

impl SessionRecord {
    pub(crate) fn from_value(value: Value) -> Result<Self, String> {
        if !matches!(value["version"].as_u64(), Some(1..=4)) {
            return Err("CS2 恢复记录版本不支持。".into());
        }
        // These fields carry recovery responsibility. A present null is damaged evidence,
        // not an absent optional feature, and must retain the original journal.
        if [
            "demoTestRequestId",
            "demoPlaybackCfg",
            "frameRateFiles",
            "frameRateLimit",
        ]
        .iter()
        .any(|key| value.get(*key).is_some_and(Value::is_null))
        {
            return Err("CS2 恢复记录字段无效，原备份仍保留。".into());
        }
        SessionIdentity::read(&value).map_err(|_| "CS2 会话身份记录无效。")?;
        if value["version"] == 3
            && [
                "original",
                "applied",
                "owned",
                "frameRateFiles",
                "frameRateLimit",
            ]
            .iter()
            .any(|key| value.get(*key).is_some())
        {
            return Err("保留设置的启动记录无效。".into());
        }
        let record: Self =
            serde_json::from_value(value).map_err(|_| "CS2 恢复记录字段无效，原备份仍保留。")?;
        record.validate()?;
        Ok(record)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(1..=4).contains(&self.version)
            || self.video.is_empty()
            || self.executable.is_empty()
            || self.pid.is_some() != self.created.is_some()
            || self.pid == Some(0)
            || (self.unconfirmed_launch() && self.launch_time.is_none())
            || (self.version == 3 && !self.preserve_settings)
            || (matches!(self.version, 1 | 2)
                && (self.original.is_none() || self.applied.is_none() || self.owned.is_none()))
            || (self.version == 2
                && (self.frame_rate_files.is_none()
                    || !matches!(self.frame_rate_limit, Some(0 | 30 | 60))))
        {
            return Err("CS2 恢复记录不完整，原备份仍保留。".into());
        }
        Ok(())
    }

    pub(crate) fn value(&self) -> Value {
        // All fields are JSON values or scalar/string-keyed data.
        serde_json::to_value(self).expect("session record is JSON serializable")
    }
    pub(crate) fn version(&self) -> u32 {
        self.version
    }
    pub(crate) fn process_identity(&self) -> Option<crate::cs2_process_identity::ProcessIdentity> {
        Some(crate::cs2_process_identity::ProcessIdentity {
            pid: self.pid?,
            created: self.created?,
            executable: self.executable.clone(),
        })
    }
    pub(crate) fn pid(&self) -> Option<u32> {
        self.pid
    }
    pub(crate) fn created(&self) -> Option<u64> {
        self.created
    }
    pub(crate) fn launch_time(&self) -> Option<u64> {
        self.launch_time
    }
    pub(crate) fn was_submitted(&self) -> bool {
        self.launch_attempted
    }
    pub(crate) fn phase(&self) -> LaunchPhase {
        if self.pid.is_some() && self.created.is_some() {
            LaunchPhase::Bound
        } else if self.launch_cancelled == Some(true) {
            LaunchPhase::Cancelled
        } else if self.launch_attempted {
            LaunchPhase::Submitted
        } else {
            LaunchPhase::Prepared
        }
    }
    pub(crate) fn unconfirmed_launch(&self) -> bool {
        self.phase() == LaunchPhase::Submitted
    }

    pub(crate) fn submit(&mut self, time: u64) -> Result<(), String> {
        if self.phase() != LaunchPhase::Prepared {
            return Err("游戏启动已提交，请先确认原启动结果。".into());
        }
        self.launch_time = Some(time);
        self.launch_attempted = true;
        Ok(())
    }
    pub(crate) fn bind(&mut self, pid: u32, created: u64) -> Result<(), String> {
        if pid == 0
            || self.launch_cancelled == Some(true)
            || !self.launch_attempted
            || self.launch_time.is_none_or(|time| created < time)
            || self.pid.is_some_and(|old| old != pid)
            || self.created.is_some_and(|old| old != created)
        {
            return Err("游戏启动身份已变化，原配置备份仍保留。".into());
        }
        self.pid = Some(pid);
        self.created = Some(created);
        Ok(())
    }
    /// Call only after independently verifying that the launcher and game have stopped.
    pub(crate) fn cancel(&mut self) -> Result<(), String> {
        if !self.unconfirmed_launch() {
            return Err("游戏启动状态已变化，请重新检查。".into());
        }
        self.launch_cancelled = Some(true);
        Ok(())
    }
    pub(crate) fn submission_failed(&mut self) {
        if self.full_snapshot {
            self.launch_cancelled = Some(true);
        } else {
            self.launch_attempted = false;
        }
    }
}
