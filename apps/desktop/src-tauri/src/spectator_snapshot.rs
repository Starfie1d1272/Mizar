//! Private, durable snapshot for a future explicitly selected spectator preset.
//! The host must establish Steam identity and confirm that CS2 cannot write.
use crate::spectator_recovery_plan::{Bindings, Input, InputKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

const LIMIT: usize = 256 * 1024;
const RECORD_LIMIT: usize = 2 * 1024 * 1024;
type Writer = fn(&Path, &[u8]) -> Result<(), String>;

// Check every existing component without following links or Windows junctions.
fn plain(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}
fn check_path(path: &Path, create_directories: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("path_invalid".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Prefix(_) => {
                current.push(part.as_os_str());
                continue;
            }
            Component::RootDir => {
                current.push(part.as_os_str());
                let metadata = fs::symlink_metadata(&current).map_err(|_| "path_invalid")?;
                if !metadata.is_dir() || !plain(&metadata) {
                    return Err("path_invalid".into());
                }
                continue;
            }
            Component::Normal(name) => current.push(name),
            _ => return Err("path_invalid".into()),
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create_directories => {
                fs::create_dir(&current).map_err(|_| "path_invalid")?;
                fs::symlink_metadata(&current).map_err(|_| "path_invalid")?
            }
            Err(_) => return Err("path_invalid".into()),
        };
        if !plain(&metadata) {
            return Err("path_invalid".into());
        }
    }
    Ok(())
}

/// A kernel-managed lock survives multiple owners but releases on crash.
/// The lock file is never removed, so an old file is not a stale lock.
pub(crate) fn acquire(root: &Path) -> Result<fs::File, String> {
    check_path(root, true)?;
    let path = root.join("spectator-full.lock");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.is_file() || !plain(&metadata) {
            return Err("path_invalid".into());
        }
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&path)
        .map_err(|_| "snapshot_lock_failed")?;
    check_path(&path, false)?;
    file.try_lock().map_err(|_| "snapshot_busy")?;
    Ok(file)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn regular(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    check_path(path, false)?;
    let m = fs::symlink_metadata(path).map_err(|_| "snapshot_file_unavailable")?;
    if !m.is_file() || !plain(&m) || m.len() > limit as u64 {
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
    check_path(video, false)?;
    check_path(executable, false)?;
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
        if !m.is_dir() || !plain(&m) {
            return Err("identity_invalid".into());
        }
    }
    regular(video, LIMIT)?;
    let m = fs::symlink_metadata(executable).map_err(|_| "identity_invalid")?;
    if !m.is_file() || !plain(&m) {
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

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Status {
    Missing,
    Pending,
    Conflict,
    Damaged,
    IdentityChanged,
    Unavailable,
}

/// Read-only inspection under the same owner lock; never returns commands.
pub(crate) fn status(root: &Path, video: &Path, exe: &Path, account: u32) -> Status {
    let path = pending(root);
    if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return Status::Missing;
    }
    let inspect = || -> Result<Status, String> {
        let bytes = regular(&path, RECORD_LIMIT).map_err(|_| "unavailable")?;
        let record: Value = serde_json::from_slice(&bytes).map_err(|_| "damaged")?;
        let payload = &record["payload"];
        if payload["version"] != 1
            || record["sha256"].as_str()
                != Some(digest(&serde_json::to_vec(payload).map_err(|_| "damaged")?).as_str())
        {
            return Err("damaged".into());
        }
        if let Some(session) =
            crate::cs2_config_identity::SessionIdentity::read(payload).map_err(|_| "damaged")?
        {
            if session.config.value() != payload["identity"] {
                return Err("damaged".into());
            }
        }
        let original = payload["original"]
            .as_str()
            .filter(|v| v.len() <= LIMIT)
            .ok_or("damaged")?;
        let (owned, applied) = decode(&payload["fields"]).map_err(|_| "damaged")?;
        crate::spectator_recovery_vcfg::restore(original, &applied, original, &owned)
            .map_err(|_| "damaged")?;
        let saved = &payload["identity"];
        let saved_account = saved["account"]
            .as_u64()
            .filter(|value| *value > 0 && *value <= u32::MAX as u64)
            .ok_or("damaged")?;
        if saved["slot"] != 0
            || saved["format"] != "vcfg"
            || ["video", "executable", "keys"].iter().any(|key| {
                saved[*key]
                    .as_str()
                    .is_none_or(|path| !Path::new(path).is_absolute())
            })
        {
            return Err("damaged".into());
        }
        if account == 0 {
            return Err("unavailable".into());
        }
        if saved_account != u64::from(account) {
            return Err("identity".into());
        }
        let (id, key) = identity(video, exe, account).map_err(|_| "unavailable")?;
        if *saved != id {
            return Err("identity".into());
        }
        let bytes = regular(&key, LIMIT).map_err(|_| "unavailable")?;
        let current = std::str::from_utf8(&bytes).map_err(|_| "unavailable")?;
        match crate::spectator_recovery_vcfg::restore(original, &applied, current, &owned) {
            Ok(_) => Ok(Status::Pending),
            Err("conflict") => Ok(Status::Conflict),
            Err(_) => Err("unavailable".into()),
        }
    };
    match inspect() {
        Ok(value) => value,
        Err(error) if error == "damaged" => Status::Damaged,
        Err(error) if error == "identity" => Status::IdentityChanged,
        Err(_) => Status::Unavailable,
    }
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
    check_path(root, false)?;
    capture_for_session(root, video, exe, account, owned, applied, write, None)
}

/// Capture with an optional explicit session identity; legacy capture remains unchanged.
pub(crate) fn capture_for_session(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    write: Writer,
    session: Option<&crate::cs2_config_identity::SessionIdentity>,
) -> Result<(), String> {
    check_path(root, false)?;
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
    let mut payload = json!({"version":1,"identity":id,"original":original,"fields":rows});
    if let Some(session) = session {
        if session.config.value() != id {
            return Err("identity_changed".into());
        }
        session.write(&mut payload).map_err(str::to_string)?;
    }
    let payload_bytes = serde_json::to_vec(&payload).map_err(|_| "snapshot_invalid")?;
    let record = serde_json::to_vec(&json!({"payload":payload,"sha256":digest(&payload_bytes)}))
        .map_err(|_| "snapshot_invalid")?;
    if record.len() > RECORD_LIMIT {
        return Err("snapshot_too_large".into());
    }
    check_path(root, false)?;
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
    check_path(root, false)?;
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
    if let Some(session) =
        crate::cs2_config_identity::SessionIdentity::read(payload).map_err(str::to_string)?
    {
        if session.config.value() != payload["identity"] {
            return Err("snapshot_invalid".into());
        }
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
        check_path(&key, false)?;
        check_path(root, false)?;
        write(&key, restored.as_bytes())?;
        if regular(&key, LIMIT)? != restored.as_bytes() {
            return Err("snapshot_readback_failed".into());
        }
    }
    check_path(root, false)?;
    let last = root.join("spectator-full-last.json");
    if fs::symlink_metadata(&last).is_ok() {
        check_path(&last, false)?;
    }
    write(&last, &bytes)?;
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
        fs::create_dir_all(root.join("state")).unwrap();
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
    fn oversized_key_file_and_failed_readback_preserve_record() {
        fn wrong(path: &Path, _: &[u8]) -> Result<(), String> {
            fs::write(path, b"wrong").map_err(|_| "write_failed".to_string())
        }
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        fs::write(&key, vec![b'x'; LIMIT + 1]).unwrap();
        assert!(capture(&state, &video, &exe, 42, &owned, &applied, write).is_err());
        assert!(!pending(&state).exists());
        fs::write(&key, O).unwrap();
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        fs::write(&key, A).unwrap();
        assert!(recover(&state, &video, &exe, 42, wrong).is_err());
        assert!(pending(&state).exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_target_is_rejected() {
        let (root, video, exe, owned, applied) = setup();
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        fs::remove_file(&key).unwrap();
        std::os::unix::fs::symlink(&video, &key).unwrap();
        assert!(capture(
            &root.join("state"),
            &video,
            &exe,
            42,
            &owned,
            &applied,
            write
        )
        .is_err());
        assert!(!pending(&root.join("state")).exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn lock_is_exclusive_and_released_when_owner_drops() {
        let (root, _, _, _, _) = setup();
        let state = root.join("state");
        let lock = acquire(&state).unwrap();
        assert!(acquire(&state).is_err());
        drop(lock);
        assert!(acquire(&state).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn status_exposes_conflict_and_damage_without_commands() {
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        assert_eq!(status(&state, &video, &exe, 42), Status::Missing);
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Pending);
        fs::write(&key, A.replace("preset", "private-value")).unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Conflict);
        assert_eq!(status(&state, &video, &exe, 43), Status::IdentityChanged);
        fs::write(pending(&state), "{}").unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Damaged);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn status_distinguishes_unavailable_files_from_proven_identity_changes() {
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        let key = video.with_file_name("cs2_user_keys_0_slot0.vcfg");
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        let other = root.join("other/bin/win64/cs2.exe");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, "exe").unwrap();
        assert_eq!(status(&state, &video, &other, 42), Status::IdentityChanged);
        assert_eq!(status(&state, &video, &exe, 0), Status::Unavailable);
        fs::remove_file(&key).unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Unavailable);
        fs::write(&key, O).unwrap();
        fs::remove_file(&exe).unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Unavailable);
        fs::remove_file(pending(&state)).unwrap();
        fs::create_dir(pending(&state)).unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Unavailable);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn status_detects_invalid_snapshot_identity_even_with_matching_digest() {
        let (root, video, exe, owned, applied) = setup();
        let state = root.join("state");
        capture(&state, &video, &exe, 42, &owned, &applied, write).unwrap();
        let path = pending(&state);
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        record["payload"]["identity"]["account"] = json!(null);
        record["sha256"] = json!(digest(&serde_json::to_vec(&record["payload"]).unwrap()));
        fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(status(&state, &video, &exe, 42), Status::Damaged);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_linked_ancestors_of_all_targets() {
        let (root, video, exe, owned, applied) = setup();
        let link = root.join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let linked_video = link.join(video.strip_prefix(&root).unwrap());
        let linked_exe = link.join(exe.strip_prefix(&root).unwrap());
        assert!(capture(
            &root.join("state"),
            &linked_video,
            &exe,
            42,
            &owned,
            &applied,
            write
        )
        .is_err());
        assert!(capture(
            &root.join("state"),
            &video,
            &linked_exe,
            42,
            &owned,
            &applied,
            write
        )
        .is_err());
        assert!(acquire(&link.join("state")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn rejects_junction_ancestors_of_all_targets() {
        let (root, video, exe, owned, applied) = setup();
        let link = root.join("junction");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&root)
            .output()
            .unwrap();
        assert!(output.status.success(), "junction fixture creation failed");
        let linked_video = link.join(video.strip_prefix(&root).unwrap());
        let linked_exe = link.join(exe.strip_prefix(&root).unwrap());
        assert!(capture(
            &root.join("state"),
            &linked_video,
            &exe,
            42,
            &owned,
            &applied,
            write
        )
        .is_err());
        assert!(capture(
            &root.join("state"),
            &video,
            &linked_exe,
            42,
            &owned,
            &applied,
            write
        )
        .is_err());
        assert!(acquire(&link.join("state")).is_err());
        fs::remove_dir(&link).unwrap();
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
