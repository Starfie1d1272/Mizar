//! Interpret current owner replies; historical step success is never a live capability.
use serde_json::Value;

pub(crate) fn obs_current(obs: &Value) -> bool {
    obs["connection"] == "connected"
        && obs["sceneAligned"] == true
        && obs["readiness"]["ready"] == true
}

pub(crate) fn obs_taken_over(obs: &Value) -> bool {
    obs["connection"] == "connected"
        && (obs["sceneAligned"] != true
            || obs["findings"].as_array().is_some_and(|findings| {
                findings
                    .iter()
                    .any(|finding| finding["code"] == "collection_inactive")
            }))
}

pub(crate) fn game_current(game: &Value, id: &str) -> bool {
    game["busy"] == false && game["running"] == true && game["preparationId"] == id
}

pub(crate) fn restart_allowed(game: &Value, camera_uncertain: bool) -> bool {
    !camera_uncertain
        && game["restartAllowed"] == true
        && game["busy"] == false
        && game["running"] == false
        && game["pending"] == false
}

#[derive(Debug, PartialEq)]
pub(crate) enum CameraEvidence {
    Ready,
    Prepare,
    Unconfirmed,
}
pub(crate) fn camera_evidence(game: &Value, id: &str, uncertain: bool) -> CameraEvidence {
    if !game_current(game, id) {
        return CameraEvidence::Unconfirmed;
    }
    match game["cameraLeaseReady"].as_bool() {
        Some(true) => CameraEvidence::Ready,
        Some(false) if !uncertain => CameraEvidence::Prepare,
        _ => CameraEvidence::Unconfirmed,
    }
}

pub(crate) fn gsi_current(gsi: &Value) -> bool {
    gsi["detected"] == true
        && gsi["installed"] == true
        && gsi["conflict"] == false
        && gsi["readFailed"] == false
}

#[derive(Debug, PartialEq)]
pub(crate) enum CaptureEvidence {
    Ready,
    Warmup,
    Unconfirmed,
}
pub(crate) fn capture_evidence(value: &Value) -> CaptureEvidence {
    match (value["state"].as_str(), value["reason"].as_str()) {
        (Some("initialized"), _) => CaptureEvidence::Ready,
        (Some("waiting"), _) | (Some("unknown"), Some("target_unavailable")) => {
            CaptureEvidence::Warmup
        }
        _ => CaptureEvidence::Unconfirmed,
    }
}
pub(crate) fn capture_failure_message(value: &Value) -> &'static str {
    match value["reason"].as_str() {
        Some("target_unavailable") => {
            "OBS 游戏采集目标不可用，请确认 CS2 窗口已打开，并在停止输出后修复 Mizar 场景，再重试准备。"
        }
        Some("target_ambiguous") => {
            "OBS 检测到多个 CS2 窗口，请关闭多余游戏窗口，再重试准备。"
        }
        Some("source_inactive") => {
            "OBS 游戏采集当前未处于激活场景，请切换到包含游戏采集的场景或保持「赛前等待」后重试。"
        }
        Some("zero_size") | Some("hook_pending") => {
            "OBS 尚未获取到 CS2 游戏画面，请保持游戏窗口开启后重试。"
        }
        Some("hook_failed") => {
            "OBS 游戏捕获钩子异常，请检查 OBS 采集权限或以兼容模式重启后重试。"
        }
        _ => "OBS 游戏捕获未确认，请检查后重试。",
    }
}
