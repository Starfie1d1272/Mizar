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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restart_requires_owner_proof_of_completed_process_and_transaction_cleanup() {
        let cleared = json!({"restartAllowed":true,"busy":false,"running":false,"pending":false});
        assert!(restart_allowed(&cleared, false));
        // An ended process/journal does not prove a timed-out companion request retired.
        assert!(!restart_allowed(&cleared, true));
        for (field, value) in [
            ("restartAllowed", false),
            ("busy", true),
            ("running", true),
            ("pending", true),
        ] {
            let mut unknown = cleared.clone();
            unknown[field] = json!(value);
            assert!(!restart_allowed(&unknown, false));
        }
        assert!(!restart_allowed(&json!({"restartAllowed":true}), false));
    }

    #[test]
    fn obs_reuse_requires_current_scene_and_owner_readiness() {
        let current = json!({"connection":"connected","sceneAligned":true,"readiness":{"ready":true},"findings":[]});
        assert!(obs_current(&current));
        assert!(!obs_taken_over(&current));
        let mut moved = current.clone();
        moved["sceneAligned"] = json!(false);
        assert!(!obs_current(&moved));
        assert!(obs_taken_over(&moved));
        moved = current.clone();
        moved["readiness"]["ready"] = json!(false);
        moved["findings"] = json!([{"code":"collection_inactive"}]);
        assert!(!obs_current(&moved));
        assert!(obs_taken_over(&moved));
        moved = current.clone();
        moved["connection"] = json!("unavailable");
        assert!(!obs_current(&moved));
        assert!(!obs_taken_over(&moved));
        assert!(!obs_current(&json!({})));
    }

    #[test]
    fn camera_requires_current_game_and_lease_not_a_past_success() {
        let current =
            json!({"busy":false,"running":true,"preparationId":"p","cameraLeaseReady":true});
        assert_eq!(camera_evidence(&current, "p", false), CameraEvidence::Ready);
        assert_eq!(camera_evidence(&current, "p", true), CameraEvidence::Ready);
        assert_eq!(
            camera_evidence(&current, "another", false),
            CameraEvidence::Unconfirmed
        );
        for (field, value) in [
            ("cameraLeaseReady", false),
            ("running", false),
            ("busy", true),
        ] {
            let mut changed = current.clone();
            changed[field] = json!(value);
            assert_ne!(camera_evidence(&changed, "p", false), CameraEvidence::Ready);
            assert_eq!(
                camera_evidence(&changed, "p", true),
                CameraEvidence::Unconfirmed
            );
        }
        assert_eq!(
            camera_evidence(&json!({"busy":true}), "p", false),
            CameraEvidence::Unconfirmed
        );
        assert_eq!(
            camera_evidence(&json!({}), "p", false),
            CameraEvidence::Unconfirmed
        );
        let mut revoked = current.clone();
        revoked["cameraLeaseReady"] = json!(false);
        assert_eq!(
            camera_evidence(&revoked, "p", false),
            CameraEvidence::Prepare
        );
        revoked.as_object_mut().unwrap().remove("cameraLeaseReady");
        assert_eq!(
            camera_evidence(&revoked, "p", false),
            CameraEvidence::Unconfirmed
        );
    }

    #[test]
    fn gsi_requires_the_owners_complete_verified_installation() {
        let current = json!({"detected":true,"installed":true,"conflict":false,"readFailed":false});
        assert!(gsi_current(&current));
        for (field, value) in [
            ("detected", false),
            ("installed", false),
            ("conflict", true),
            ("readFailed", true),
        ] {
            let mut changed = current.clone();
            changed[field] = json!(value);
            assert!(!gsi_current(&changed));
        }
        assert!(!gsi_current(&json!({"installed":true})));
    }

    #[test]
    fn capture_unknown_never_becomes_permission_to_repeat_warmup() {
        assert_eq!(
            capture_evidence(&json!({"state":"initialized"})),
            CaptureEvidence::Ready
        );
        assert_eq!(
            capture_evidence(&json!({"state":"waiting"})),
            CaptureEvidence::Warmup
        );
        for state in [
            json!({"state":"unknown"}),
            json!({"state":"failed"}),
            json!({}),
        ] {
            assert_eq!(capture_evidence(&state), CaptureEvidence::Unconfirmed);
        }
    }
}
