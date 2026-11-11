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
    match value["state"].as_str() {
        Some("initialized") => CaptureEvidence::Ready,
        Some("waiting") => CaptureEvidence::Warmup,
        _ => CaptureEvidence::Unconfirmed,
    }
}
