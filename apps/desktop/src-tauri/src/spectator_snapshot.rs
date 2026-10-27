//! Private, durable snapshot for a future explicitly selected spectator preset.
//! The host must establish Steam identity and confirm that CS2 cannot write.
use crate::spectator_recovery_plan::{Bindings, Input, InputKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const LIMIT: usize = 256 * 1024;
const RECORD_LIMIT: usize = 2 * 1024 * 1024;
type Writer = fn(&Path, &[u8]) -> Result<(), String>;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn regular(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let m = fs::symlink_metadata(path).map_err(|_| "snapshot_file_unavailable")?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > limit as u64 {
        return Err("snapshot_file_invalid".into());
    }
    let bytes = fs::read(path).map_err(|_| "snapshot_read_failed")?;
    if bytes.len() > limit {
        return Err("snapshot_file_invalid".into());
    }
    Ok(bytes)
}
fn identity(video: &Path, executable: &Path, account: u32) -> Result<(Value, PathBuf), String> {
    if account == 0
        || !video.is_absolute()
        || !executable.is_absolute()
        || video.file_name().is_none_or(|n| n != "cs2_video.txt")
        || executable
            .file_name()
            .is_none_or(|n| !n.to_string_lossy().eq_ignore_ascii_case("cs2.exe"))
    {
        return Err("identity_invalid".into());
    }
    let cfg = video.parent().ok_or("identity_invalid")?;
    let local = cfg.parent().ok_or("identity_invalid")?;
    let app = local.parent().ok_or("identity_invalid")?;
    let user = app.parent().ok_or("identity_invalid")?;
    if cfg.file_name().is_none_or(|n| n != "cfg")
        || local.file_name().is_none_or(|n| n != "local")
        || app.file_name().is_none_or(|n| n != "730")
        || user
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<u32>().ok())
            != Some(account)
    {
        return Err("identity_invalid".into());
    }
    for directory in [cfg, local, app, user] {
        let m = fs::symlink_metadata(directory).map_err(|_| "identity_invalid")?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err("identity_invalid".into());
        }
    }
    regular(video, LIMIT)?;
    let m = fs::symlink_metadata(executable).map_err(|_| "identity_invalid")?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err("identity_invalid".into());
    }
    let key = cfg.join("cs2_user_keys_0_slot0.vcfg");
    regular(&key, LIMIT)?;
    let canonical = |p: &Path| fs::canonicalize(p).map_err(|_| "identity_invalid".to_string());
    Ok((
        json!({"account":account,"video":canonical(video)?,"executable":canonical(executable)?,"keys":canonical(&key)?,"slot":0,"format":"vcfg"}),
        key,
    ))
}
fn entries(owned: &BTreeSet<Input>, applied: &Bindings) -> Result<Value, String> {
    if owned.is_empty() || owned.len() > 1024 || applied.keys().any(|k| !owned.contains(k)) {
        return Err("scope_invalid".into());
    }
    let mut rows = Vec::new();
    for key in owned {
        if key.name.is_empty() || key.name.len() > 256 {
            return Err("scope_invalid".into());
        }
        let values = applied.get(key);
        if values
            .is_some_and(|v| v.is_empty() || v.len() > 128 || v.iter().any(|s| s.len() > LIMIT))
        {
            return Err("scope_invalid".into());
        }
        rows.push(json!({"kind":match key.kind {InputKind::Key=>"key",InputKind::Axis=>"axis"},"name":key.name,"applied":values}));
    }
    Ok(json!(rows))
}
fn decode(value: &Value) -> Result<(BTreeSet<Input>, Bindings), String> {
    let rows = value
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 1024)
        .ok_or("snapshot_invalid")?;
    let mut owned = BTreeSet::new();
    let mut applied = Bindings::new();
    for row in rows {
        let kind = match row["kind"].as_str() {
            Some("key") => InputKind::Key,
            Some("axis") => InputKind::Axis,
            _ => return Err("snapshot_invalid".into()),
        };
        let name = row["name"]
            .as_str()
            .filter(|n| !n.is_empty() && n.len() <= 256)
            .ok_or("snapshot_invalid")?;
        let key = Input {
            kind,
            name: name.to_string(),
        };
        if !owned.insert(key.clone()) {
            return Err("snapshot_invalid".into());
        }
        if !row["applied"].is_null() {
            let values: Vec<String> =
                serde_json::from_value(row["applied"].clone()).map_err(|_| "snapshot_invalid")?;
            if values.is_empty() || values.len() > 128 || values.iter().any(|s| s.len() > LIMIT) {
                return Err("snapshot_invalid".into());
            }
            applied.insert(key, values);
        } else if row.get("applied").is_none() {
            return Err("snapshot_invalid".into());
        }
    }
    Ok((owned, applied))
}
fn pending(root: &Path) -> PathBuf {
    root.join("spectator-full-pending.json")
}

pub(crate) fn capture(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    write: Writer,
) -> Result<(), String> {
    let record_path = pending(root);
    match fs::symlink_metadata(&record_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        _ => return Err("snapshot_pending".into()),
    }
    let (id, path) = identity(video, exe, account)?;
    let bytes = regular(&path, LIMIT)?;
    let original = std::str::from_utf8(&bytes).map_err(|_| "snapshot_encoding")?;
    let rows = entries(owned, applied)?;
    // Validate the original structure before persisting ownership.
    crate::spectator_recovery_vcfg::restore(original, applied, original, owned)
        .map_err(str::to_string)?;
    if identity(video, exe, account)?.0 != id || regular(&path, LIMIT)? != bytes {
        return Err("snapshot_changed".into());
    }
    let payload = json!({"version":1,"identity":id,"original":original,"fields":rows});
    let payload_bytes = serde_json::to_vec(&payload).map_err(|_| "snapshot_invalid")?;
    let record = serde_json::to_vec(&json!({"payload":payload,"sha256":digest(&payload_bytes)}))
        .map_err(|_| "snapshot_invalid")?;
    if record.len() > RECORD_LIMIT {
        return Err("snapshot_too_large".into());
    }
    write(&record_path, &record)?;
    if regular(&record_path, RECORD_LIMIT)? != record {
        return Err("snapshot_readback_failed".into());
    }
    if identity(video, exe, account)?.0 != id || regular(&path, LIMIT)? != bytes {
        return Err("snapshot_changed".into());
    }
    Ok(())
}

pub(crate) fn recover(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    write: Writer,
) -> Result<(), String> {
    let path = pending(root);
    let bytes = regular(&path, RECORD_LIMIT)?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "snapshot_invalid")?;
    let payload = &record["payload"];
    if payload["version"] != 1
        || record["sha256"].as_str()
            != Some(digest(&serde_json::to_vec(payload).map_err(|_| "snapshot_invalid")?).as_str())
    {
        return Err("snapshot_invalid".into());
    }
    let (id, key) = identity(video, exe, account)?;
    if payload["identity"] != id {
        return Err("identity_changed".into());
    }
    let original = payload["original"]
        .as_str()
        .filter(|s| s.len() <= LIMIT)
        .ok_or("snapshot_invalid")?;
    let (owned, applied) = decode(&payload["fields"])?;
    let current_bytes = regular(&key, LIMIT)?;
    let current = std::str::from_utf8(&current_bytes).map_err(|_| "snapshot_encoding")?;
    let result = crate::spectator_recovery_vcfg::restore(original, &applied, current, &owned)
        .map_err(str::to_string)?;
    if identity(video, exe, account)?.0 != id
        || regular(&key, LIMIT)? != current_bytes
        || regular(&path, RECORD_LIMIT)? != bytes
    {
        return Err("snapshot_changed".into());
    }
    if let Some(restored) = result {
        write(&key, restored.as_bytes())?;
        if regular(&key, LIMIT)? != restored.as_bytes() {
            return Err("snapshot_readback_failed".into());
        }
    }
    write(&root.join("spectator-full-last.json"), &bytes)?;
    if regular(&root.join("spectator-full-last.json"), RECORD_LIMIT)? != bytes {
        return Err("snapshot_readback_failed".into());
    }
    fs::remove_file(path).map_err(|_| "snapshot_cleanup_failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    const O: &str =
        "\"config\" {\"bindings\" {\"x\" \"\"} \"analogbindings\" {\"mouse_x\" \"old\"}}";
    const A: &str = "\"config\" {\"bindings\" {\"x\" \"preset\" \"extra\" \"keep\"} \"analogbindings\" {\"mouse_x\" \"new\"}}";
    fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        fs::create_dir_all(path.parent().unwrap()).map_err(|_| "write_failed")?;
        let tmp = path.with_extension("test-tmp");
        fs::write(&tmp, bytes).map_err(|_| "write_failed")?;
        fs::rename(tmp, path).map_err(|_| "write_failed".to_string())
    }
    fn setup() -> (PathBuf, PathBuf, PathBuf, BTreeSet<Input>, Bindings) {
        let root = std::env::temp_dir().join(format!(
            "mizar-snapshot-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let cfg = root.join("steam/userdata/42/730/local/cfg");
        fs::create_dir_all(&cfg).unwrap();
        let video = cfg.join("cs2_video.txt");
        fs::write(&video, "video").unwrap();
        fs::write(cfg.join("cs2_user_keys_0_slot0.vcfg"), O).unwrap();
        let exe = root.join("game/bin/win64/cs2.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "exe").unwrap();
        let x = Input {
            kind: InputKind::Key,
            name: "x".into(),
        };
        let axis = Input {
            kind: InputKind::Axis,
            name: "mouse_x".into(),
        };
        let owned = [x.clone(), axis.clone()].into();
        let applied = [(x, vec!["preset".into()]), (axis, vec!["new".into()])].into();
        (root, video, exe, owned, applied)
    }
    #[test]
    fn capture_restore_retry_and_preserve_unowned() {
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        assert_eq!(fs::read_to_string(&key).unwrap(), O);
        fs::write(&key, A).unwrap();
        recover(&state, &video, &exe, 42, write).unwrap();
        let restored = fs::read_to_string(&key).unwrap();
        assert!(restored.contains("\"x\" \"\""));
        assert!(restored.contains("\"mouse_x\" \"old\""));
        assert!(restored.contains("\"extra\" \"keep\""));
        assert!(!pending(&state).exists());
        assert!(state.join("spectator-full-last.json").exists());
        // Simulate a crash after replacement and before journal cleanup.
        fs::copy(state.join("spectator-full-last.json"), pending(&state)).unwrap();
        recover(&state, &video, &exe, 42, write).unwrap();
        assert_eq!(fs::read_to_string(key).unwrap(), restored);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn conflict_wrong_account_and_corrupt_snapshot_never_write() {
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        fs::write(&key, A.replace("preset", "external")).unwrap();
        let current = fs::read(&key).unwrap();
        assert!(recover(&state, &video, &exe, 42, write).is_err());
        assert_eq!(fs::read(&key).unwrap(), current);
        assert!(recover(&state, &video, &exe, 43, write).is_err());
        assert_eq!(fs::read(&key).unwrap(), current);
        fs::write(pending(&state), "{}").unwrap();
        assert!(recover(&state, &video, &exe, 42, write).is_err());
        assert_eq!(fs::read(&key).unwrap(), current);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_recovery_keeps_record_for_retry() {
        fn fail(_: &Path, _: &[u8]) -> Result<(), String> {
            Err("write_failed".into())
        }
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        fs::write(&key, A).unwrap();
        assert!(recover(&state, &video, &exe, 42, fail).is_err());
        assert_eq!(fs::read_to_string(&key).unwrap(), A);
        assert!(pending(&state).exists());
        recover(&state, &video, &exe, 42, write).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_backup_leaves_game_unchanged() {
        fn fail(_: &Path, _: &[u8]) -> Result<(), String> {
            Err("write_failed".into())
        }
        let (root, video, exe, owned, applied) = setup();
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        assert!(capture(
            &root.join("state"),
            &video,
            &exe,
            42,
            &owned,
            &applied,
            fail
        )
        .is_err());
        assert_eq!(fs::read_to_string(key).unwrap(), O);
        fs::remove_dir_all(root).unwrap();
    }
}
