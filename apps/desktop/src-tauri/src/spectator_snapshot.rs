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
pub(crate) fn check_path(path: &Path, create_directories: bool) -> Result<(), String> {
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
pub(crate) fn identity(
    video: &Path,
    executable: &Path,
    account: u32,
    slot: u32,
) -> Result<(Value, PathBuf), String> {
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
    let key = cfg.join(format!("cs2_user_keys_0_slot{slot}.vcfg"));
    regular(&key, LIMIT)?;
    let canonical = |p: &Path| fs::canonicalize(p).map_err(|_| "identity_invalid".to_string());
    Ok((
        json!({"account":account,"video":canonical(video)?,"executable":canonical(executable)?,"keys":canonical(&key)?,"slot":slot,"format":"vcfg"}),
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
        let slot = saved["slot"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("damaged")?;
        if (crate::cs2_config_identity::SessionIdentity::read(payload)
            .map_err(|_| "damaged")?
            .is_none()
            && slot != 0)
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
        let (id, key) = identity(video, exe, account, slot).map_err(|_| "unavailable")?;
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

/// Prepare the exact local key-file application without touching disk.
pub(crate) fn plan_application(
    video: &Path,
    exe: &Path,
    account: u32,
    session: &crate::cs2_config_identity::SessionIdentity,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    candidate: &str,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), String> {
    let (id, path) = identity(video, exe, account, session.config.slot)?;
    if session.config.value() != id {
        return Err("identity_changed".into());
    }
    let original = regular(&path, LIMIT)?;
    let text = std::str::from_utf8(&original).map_err(|_| "snapshot_encoding")?;
    let planned = crate::spectator_recovery_vcfg::plan_application(text, candidate, applied, owned)
        .map_err(str::to_string)?;
    if identity(video, exe, account, session.config.slot)?.0 != id
        || regular(&path, LIMIT)? != original
    {
        return Err("snapshot_changed".into());
    }
    Ok((path, original, planned.into_bytes()))
}

/// Check the saved record and original file against the plan immediately before writes.
pub(crate) fn verify_prepared(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    session: &crate::cs2_config_identity::SessionIdentity,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    original: &[u8],
    expected_attempted: bool,
) -> Result<(), String> {
    let bytes = regular(&pending(root), RECORD_LIMIT)?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "snapshot_invalid")?;
    let payload = &record["payload"];
    if payload["version"] != 1
        || record["sha256"].as_str()
            != Some(digest(&serde_json::to_vec(payload).map_err(|_| "snapshot_invalid")?).as_str())
        || crate::cs2_config_identity::SessionIdentity::read(payload)
            .map_err(str::to_string)?
            .as_ref()
            != Some(session)
        || payload["identity"] != session.config.value()
        || payload["fields"] != entries(owned, applied)?
        || payload["original"].as_str().map(str::as_bytes) != Some(original)
        || payload["coordinatedWriteAttempted"] != expected_attempted
    {
        return Err("snapshot_invalid".into());
    }
    let (id, key) = identity(video, exe, account, session.config.slot)?;
    if id != session.config.value() || regular(&key, LIMIT)? != original {
        return Err("snapshot_changed".into());
    }
    Ok(())
}

pub(crate) fn verify_applied(
    video: &Path,
    exe: &Path,
    account: u32,
    session: &crate::cs2_config_identity::SessionIdentity,
    expected: &[u8],
) -> Result<(), String> {
    let (id, key) = identity(video, exe, account, session.config.slot)?;
    if id != session.config.value() || regular(&key, LIMIT)? != expected {
        return Err("snapshot_readback_failed".into());
    }
    Ok(())
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
    capture_inner(
        root, video, exe, account, owned, applied, write, session, false,
    )
}

pub(crate) fn capture_coordinated(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    write: Writer,
    session: &crate::cs2_config_identity::SessionIdentity,
) -> Result<(), String> {
    capture_inner(
        root,
        video,
        exe,
        account,
        owned,
        applied,
        write,
        Some(session),
        true,
    )
}

fn capture_inner(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    write: Writer,
    session: Option<&crate::cs2_config_identity::SessionIdentity>,
    coordinated: bool,
) -> Result<(), String> {
    check_path(root, false)?;
    let record_path = pending(root);
    match fs::symlink_metadata(&record_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        _ => return Err("snapshot_pending".into()),
    }
    let slot = session.map_or(0, |session| session.config.slot);
    let (id, path) = identity(video, exe, account, slot)?;
    let bytes = regular(&path, LIMIT)?;
    let original = std::str::from_utf8(&bytes).map_err(|_| "snapshot_encoding")?;
    let rows = entries(owned, applied)?;
    // Validate the original structure before persisting ownership.
    crate::spectator_recovery_vcfg::restore(original, applied, original, owned)
        .map_err(str::to_string)?;
    if identity(video, exe, account, slot)?.0 != id || regular(&path, LIMIT)? != bytes {
        return Err("snapshot_changed".into());
    }
    let mut payload = json!({"version":1,"identity":id,"original":original,"fields":rows});
    if let Some(session) = session {
        if session.config.value() != id {
            return Err("identity_changed".into());
        }
        session.write(&mut payload).map_err(str::to_string)?;
    }
    if coordinated {
        payload["coordinatedWriteAttempted"] = json!(false);
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
    if identity(video, exe, account, slot)?.0 != id || regular(&path, LIMIT)? != bytes {
        return Err("snapshot_changed".into());
    }
    Ok(())
}

/// Mark the snapshot before either coordinated owner can write A.
pub(crate) fn mark_coordinated_write(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    session: &crate::cs2_config_identity::SessionIdentity,
    owned: &BTreeSet<Input>,
    applied: &Bindings,
    original: &[u8],
    write: Writer,
) -> Result<(), String> {
    verify_prepared(
        root, video, exe, account, session, owned, applied, original, false,
    )?;
    let path = pending(root);
    let before = regular(&path, RECORD_LIMIT)?;
    let mut record: Value = serde_json::from_slice(&before).map_err(|_| "snapshot_invalid")?;
    record["payload"]["coordinatedWriteAttempted"] = json!(true);
    record["sha256"] = json!(digest(
        &serde_json::to_vec(&record["payload"]).map_err(|_| "snapshot_invalid")?
    ));
    let next = serde_json::to_vec(&record).map_err(|_| "snapshot_invalid")?;
    if next.len() > RECORD_LIMIT || regular(&path, RECORD_LIMIT)? != before {
        return Err("snapshot_changed".into());
    }
    write(&path, &next)?;
    if regular(&path, RECORD_LIMIT)? != next {
        return Err("snapshot_readback_failed".into());
    }
    verify_prepared(
        root, video, exe, account, session, owned, applied, original, true,
    )
}

/// Clear only a provably pre-write orphan; do not touch the current key file.
pub(crate) fn finish_unwritten_preparation(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    write: Writer,
) -> Result<bool, String> {
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
    let terminal = payload.get("coreTerminal");
    let terminal_unwritten = terminal.is_none_or(|t| {
        t["configWriteAttempted"] == false
            && t["launchAttempted"] == false
            && t["pid"].is_null()
            && t["created"].is_null()
    });
    if payload["coordinatedWriteAttempted"] != false || !terminal_unwritten {
        return Ok(false);
    }
    let session = crate::cs2_config_identity::SessionIdentity::read(payload)
        .map_err(str::to_string)?
        .ok_or("snapshot_invalid")?;
    let (id, _) = identity(video, exe, account, session.config.slot)?;
    if session.config.value() != id || payload["identity"] != id {
        return Err("identity_changed".into());
    }
    let original = payload["original"]
        .as_str()
        .filter(|s| s.len() <= LIMIT)
        .ok_or("snapshot_invalid")?;
    let (owned, applied) = decode(&payload["fields"])?;
    crate::spectator_recovery_vcfg::restore(original, &applied, original, &owned)
        .map_err(str::to_string)?;
    if regular(&path, RECORD_LIMIT)? != bytes {
        return Err("snapshot_changed".into());
    }
    let last = root.join("spectator-full-last.json");
    if fs::symlink_metadata(&last).is_ok() {
        check_path(&last, false)?;
    }
    write(&last, &bytes)?;
    if regular(&last, RECORD_LIMIT)? != bytes || regular(&path, RECORD_LIMIT)? != bytes {
        return Err("snapshot_readback_failed".into());
    }
    fs::remove_file(path).map_err(|_| "snapshot_cleanup_failed".to_string())?;
    Ok(true)
}

/// Only a verified handoff and two explicit false write markers prove no
/// configuration was written. Missing or asymmetric markers remain conservative.
pub(crate) fn handed_off_unwritten(root: &Path, core: &Value) -> Result<bool, String> {
    if !has_terminal(root)? {
        return Ok(false);
    }
    let bytes = regular(&pending(root), RECORD_LIMIT)?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "snapshot_invalid")?;
    let payload = &record["payload"];
    if record["sha256"].as_str()
        != Some(digest(&serde_json::to_vec(payload).map_err(|_| "snapshot_invalid")?).as_str())
    {
        return Err("snapshot_invalid".into());
    }
    let terminal = &payload["coreTerminal"];
    let full_session = crate::cs2_config_identity::SessionIdentity::read(payload)
        .map_err(str::to_string)?
        .ok_or("identity_changed")?;
    let core_session = crate::cs2_config_identity::SessionIdentity::read(core)
        .map_err(str::to_string)?
        .ok_or("identity_changed")?;
    if full_session != core_session
        || payload["identity"] != full_session.config.value()
        || core["configWriteAttempted"] != terminal["configWriteAttempted"]
        || core["launchAttempted"] != terminal["launchAttempted"]
        || core["pid"] != terminal["pid"]
        || core["created"] != terminal["created"]
        || regular(&pending(root), RECORD_LIMIT)? != bytes
    {
        return Err("snapshot_changed".into());
    }
    let unwritten = payload["coordinatedWriteAttempted"] == false
        && terminal["configWriteAttempted"] == false
        && terminal["launchAttempted"] == false
        && terminal["pid"].is_null()
        && terminal["created"].is_null();
    if unwritten {
        let original = payload["original"]
            .as_str()
            .filter(|s| s.len() <= LIMIT)
            .ok_or("snapshot_invalid")?;
        let (owned, applied) = decode(&payload["fields"])?;
        crate::spectator_recovery_vcfg::restore(original, &applied, original, &owned)
            .map_err(str::to_string)?;
    }
    Ok(unwritten)
}

/// Persist the terminated core's public recovery facts before clearing it.
/// The caller must already have confirmed CS2 is stopped.
pub(crate) fn handoff(
    root: &Path,
    video: &Path,
    exe: &Path,
    account: u32,
    core: &Value,
    write: Writer,
) -> Result<(), String> {
    check_path(root, false)?;
    let path = pending(root);
    let bytes = regular(&path, RECORD_LIMIT)?;
    let mut record: Value = serde_json::from_slice(&bytes).map_err(|_| "snapshot_invalid")?;
    let payload = &record["payload"];
    if payload["version"] != 1
        || record["sha256"].as_str()
            != Some(digest(&serde_json::to_vec(payload).map_err(|_| "snapshot_invalid")?).as_str())
    {
        return Err("snapshot_invalid".into());
    }
    let full_session = crate::cs2_config_identity::SessionIdentity::read(payload)
        .map_err(str::to_string)?
        .ok_or("identity_changed")?;
    let core_session = crate::cs2_config_identity::SessionIdentity::read(core)
        .map_err(str::to_string)?
        .ok_or("identity_changed")?;
    let (id, _) = identity(video, exe, account, full_session.config.slot)?;
    let core_video = core["video"]
        .as_str()
        .map(Path::new)
        .ok_or("identity_changed")?;
    let core_exe = core["executable"]
        .as_str()
        .map(Path::new)
        .ok_or("identity_changed")?;
    check_path(core_video, false).map_err(|_| "identity_changed")?;
    check_path(core_exe, false).map_err(|_| "identity_changed")?;
    if fs::canonicalize(core_video).map_err(|_| "identity_changed")? != full_session.config.video
        || fs::canonicalize(core_exe).map_err(|_| "identity_changed")?
            != full_session.config.executable
    {
        return Err("identity_changed".into());
    }
    if full_session != core_session
        || full_session.config.value() != id
        || payload["identity"] != id
        || core["fullSnapshot"] != true
    {
        return Err("identity_changed".into());
    }
    let attempted = core["launchAttempted"]
        .as_bool()
        .ok_or("snapshot_invalid")?;
    let config_attempted = core["configWriteAttempted"]
        .as_bool()
        .ok_or("snapshot_invalid")?;
    let cancelled = match core.get("launchCancelled") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Bool(v)) => json!(v),
        _ => return Err("snapshot_invalid".into()),
    };
    let pid = match core.get("pid") {
        None | Some(Value::Null) => Value::Null,
        Some(v) if v.as_u64().is_some() => v.clone(),
        _ => return Err("snapshot_invalid".into()),
    };
    let created = match core.get("created") {
        None | Some(Value::Null) => Value::Null,
        Some(v) if v.as_u64().is_some() => v.clone(),
        _ => return Err("snapshot_invalid".into()),
    };
    let terminal = json!({"launchAttempted":attempted,"launchCancelled":cancelled,"pid":pid,"created":created,"configWriteAttempted":config_attempted});
    if let Some(previous) = payload.get("coreTerminal") {
        if *previous != terminal {
            return Err("snapshot_changed".into());
        }
        return Ok(());
    }
    record["payload"]["coreTerminal"] = terminal;
    record["sha256"] = json!(digest(
        &serde_json::to_vec(&record["payload"]).map_err(|_| "snapshot_invalid")?
    ));
    let next = serde_json::to_vec(&record).map_err(|_| "snapshot_invalid")?;
    if next.len() > RECORD_LIMIT
        || regular(&path, RECORD_LIMIT)? != bytes
        || identity(video, exe, account, full_session.config.slot)?.0 != id
    {
        return Err("snapshot_changed".into());
    }
    write(&path, &next)?;
    if regular(&path, RECORD_LIMIT)? != next {
        return Err("snapshot_readback_failed".into());
    }
    Ok(())
}

/// Validate the protected snapshot before accepting a core launch-state update.
pub(crate) fn linked_session(
    root: &Path,
) -> Result<Option<crate::cs2_config_identity::SessionIdentity>, String> {
    let bytes = regular(&pending(root), RECORD_LIMIT)?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "snapshot_invalid")?;
    let payload = &record["payload"];
    if payload["version"] != 1
        || record["sha256"].as_str()
            != Some(digest(&serde_json::to_vec(payload).map_err(|_| "snapshot_invalid")?).as_str())
    {
        return Err("snapshot_invalid".into());
    }
    let session =
        crate::cs2_config_identity::SessionIdentity::read(payload).map_err(str::to_string)?;
    if session
        .as_ref()
        .is_some_and(|session| session.config.value() != payload["identity"])
    {
        return Err("snapshot_invalid".into());
    }
    Ok(session)
}

/// A remaining coordinated snapshot may be retried only after terminal handoff.
pub(crate) fn has_terminal(root: &Path) -> Result<bool, String> {
    let bytes = regular(&pending(root), RECORD_LIMIT)?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|_| "snapshot_invalid")?;
    let payload = &record["payload"];
    if payload["version"] != 1
        || record["sha256"].as_str()
            != Some(digest(&serde_json::to_vec(payload).map_err(|_| "snapshot_invalid")?).as_str())
    {
        return Err("snapshot_invalid".into());
    }
    let session = crate::cs2_config_identity::SessionIdentity::read(payload)
        .map_err(str::to_string)?
        .ok_or("snapshot_invalid")?;
    if session.config.value() != payload["identity"] {
        return Err("snapshot_invalid".into());
    }
    let terminal = &payload["coreTerminal"];
    if !terminal.is_object()
        || !terminal["launchAttempted"].is_boolean()
        || !terminal["configWriteAttempted"].is_boolean()
    {
        return Ok(false);
    }
    if terminal["launchAttempted"] == true
        && terminal["launchCancelled"] != true
        && (terminal["pid"].as_u64().is_none() || terminal["created"].as_u64().is_none())
    {
        return Err("launch_unconfirmed".into());
    }
    Ok(true)
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
    let slot = payload["identity"]["slot"]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("snapshot_invalid")?;
    if crate::cs2_config_identity::SessionIdentity::read(payload)
        .map_err(str::to_string)?
        .is_none()
        && slot != 0
    {
        return Err("snapshot_invalid".into());
    }
    let (id, key) = identity(video, exe, account, slot)?;
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
    if identity(video, exe, account, slot)?.0 != id
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
