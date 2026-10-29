//! Bounded, read-only eligibility for a local keyboard configuration.
//! Reasons are fixed codes; no personal commands leave this module.
use crate::{
    cs2_config_identity::ConfigIdentity, cs2_frame_rate, default_resource, spectator_snapshot,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Reason {
    Identity,
    MissingKeys,
    MultipleKeys,
    UnsupportedKeys,
    InvalidKeys,
    DefaultSource,
    ScriptUnavailable,
    ScriptConflict,
    ScriptDynamic,
    Changed,
}
impl Reason {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Identity => "无法确认当前账号或游戏配置位置，使用基础观战模式。",
            Self::MissingKeys => "未找到当前账号的本地键位配置，使用基础观战模式。",
            Self::MultipleKeys => "发现多个不一致的键位配置，使用基础观战模式。",
            Self::UnsupportedKeys => "发现无法确认归属的键位配置，使用基础观战模式。",
            Self::InvalidKeys => "键位配置格式无法安全解析，使用基础观战模式。",
            Self::DefaultSource => "当前安装的默认键位资源无法安全读取，使用基础观战模式。",
            Self::ScriptUnavailable => "个人启动配置无法安全检查，使用基础观战模式。",
            Self::ScriptConflict => "个人启动配置会改动键位，使用基础观战模式。",
            Self::ScriptDynamic => "个人启动配置包含无法确认顺序的动态命令，使用基础观战模式。",
            Self::Changed => "配置在准备期间发生变化，使用基础观战模式。",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Fingerprint {
    pub identity: ConfigIdentity,
    pub key_sha256: String,
    pub default_sha256: String,
    pub source: String,
    pub source_identity: Vec<String>,
    pub scripts: Vec<(PathBuf, String)>,
    pub mirrors: Vec<(PathBuf, String)>,
}
pub(crate) struct Eligible {
    pub fingerprint: Fingerprint,
    pub defaults: default_resource::Resource,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>, Reason> {
    spectator_snapshot::check_path(path, false).map_err(|_| Reason::ScriptUnavailable)?;
    let m = fs::symlink_metadata(path).map_err(|_| Reason::ScriptUnavailable)?;
    if !m.is_file() || m.len() > limit {
        return Err(Reason::ScriptUnavailable);
    }
    let bytes = fs::read(path).map_err(|_| Reason::ScriptUnavailable)?;
    if bytes.len() as u64 > limit {
        return Err(Reason::ScriptUnavailable);
    }
    Ok(bytes)
}
fn optional(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, Reason> {
    let parent = path.parent().ok_or(Reason::ScriptUnavailable)?;
    spectator_snapshot::check_path(parent, false).map_err(|_| Reason::ScriptUnavailable)?;
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Reason::ScriptUnavailable),
        Ok(_) => read(path, limit).map(Some),
    }
}
fn key_slot(cfg: &Path) -> Result<u32, Reason> {
    spectator_snapshot::check_path(cfg, false).map_err(|_| Reason::Identity)?;
    let mut slots = BTreeSet::new();
    let mut count = 0;
    for item in fs::read_dir(cfg).map_err(|_| Reason::MissingKeys)? {
        let item = item.map_err(|_| Reason::MissingKeys)?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| Reason::UnsupportedKeys)?
            .to_ascii_lowercase();
        if !name.starts_with("cs2_user_keys") || !name.ends_with(".vcfg") {
            continue;
        }
        count += 1;
        if count > 32 {
            return Err(Reason::MultipleKeys);
        }
        let slot = name
            .strip_prefix("cs2_user_keys_0_slot")
            .and_then(|s| s.strip_suffix(".vcfg"))
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or(Reason::UnsupportedKeys)?;
        if name != format!("cs2_user_keys_0_slot{slot}.vcfg") {
            return Err(Reason::UnsupportedKeys);
        }
        if !slots.insert(slot) {
            return Err(Reason::MultipleKeys);
        }
    }
    match slots.len() {
        0 => Err(Reason::MissingKeys),
        1 => Ok(*slots.iter().next().unwrap()),
        _ => Err(Reason::MultipleKeys),
    }
}
fn key_format(bytes: &[u8]) -> Result<(), Reason> {
    let text = std::str::from_utf8(bytes).map_err(|_| Reason::InvalidKeys)?;
    for section in ["bindings", "analogbindings"] {
        let entries = cs2_frame_rate::scalar_section(text, &["config", section])
            .map_err(|_| Reason::InvalidKeys)?;
        let mut names = BTreeMap::<String, String>::new();
        for (key, _) in entries {
            let normalized = key.value.to_ascii_lowercase();
            if normalized.is_empty() {
                return Err(Reason::InvalidKeys);
            }
            if let Some(previous) = names.insert(normalized, key.value.clone()) {
                if previous != key.value {
                    return Err(Reason::InvalidKeys);
                }
            }
        }
    }
    Ok(())
}
fn script_guard(video: &Path, exe: &Path) -> Result<Vec<(PathBuf, String)>, Reason> {
    let account = video
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or(Reason::Identity)?;
    let game = exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or(Reason::Identity)?;
    let cfg = game.join("csgo/cfg");
    let local = account.join("config/localconfig.vdf");
    let mut fingerprints = Vec::new();
    let mut pending = vec![("autoexec.cfg".to_string(), true)];
    let mut aliases = BTreeSet::new();
    let mut commands = BTreeSet::new();
    if let Some(bytes) = optional(&local, 16 * 1024 * 1024)? {
        let text = std::str::from_utf8(&bytes).map_err(|_| Reason::ScriptUnavailable)?;
        fingerprints.push((local.clone(), hash(&bytes)));
        if let Some(options) = cs2_frame_rate::field(
            text,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "Apps",
                "730",
                "LaunchOptions",
            ],
        )
        .map_err(|_| Reason::ScriptUnavailable)?
        {
            let tokens =
                cs2_frame_rate::lex(&options.value, true).map_err(|_| Reason::ScriptUnavailable)?;
            for (i, t) in tokens.iter().enumerate() {
                let cmd = t.value.to_ascii_lowercase();
                if let Some(cmd) = cmd.strip_prefix('+') {
                    commands.insert(cmd.to_string());
                }
                if matches!(
                    cmd.as_str(),
                    "+bind"
                        | "+unbind"
                        | "+unbindall"
                        | "+binddefaults"
                        | "+writekeybindings"
                        | "+host_writeconfig"
                ) {
                    return Err(Reason::ScriptConflict);
                }
                if cmd == "+spec_usenumberkeys_nobinds"
                    || (matches!(cmd.as_str(), "+toggle" | "+incrementvar")
                        && tokens.get(i + 1).is_some_and(|v| {
                            v.value.eq_ignore_ascii_case("spec_usenumberkeys_nobinds")
                        }))
                {
                    return Err(Reason::ScriptConflict);
                }
                if matches!(cmd.as_str(), "+alias" | "+exec_async") {
                    return Err(Reason::ScriptDynamic);
                }
                if matches!(cmd.as_str(), "+exec" | "+execifexists") {
                    let name = tokens
                        .get(i + 1)
                        .filter(|x| !x.value.starts_with('+') && x.value != ";")
                        .ok_or(Reason::ScriptDynamic)?;
                    pending.push((name.value.clone(), cmd == "+execifexists"));
                }
            }
        }
    } else {
        fingerprints.push((local, "absent".into()));
    }
    let mut visited = BTreeSet::new();
    let mut total = 0usize;
    while let Some((name, optional_file)) = pending.pop() {
        let path = cs2_frame_rate::included_path(&cfg, &name).map_err(|_| Reason::ScriptDynamic)?;
        let bytes = match optional(&path, 256 * 1024)? {
            Some(bytes) => bytes,
            None if optional_file => {
                fingerprints.push((path, "absent".into()));
                continue;
            }
            None => return Err(Reason::ScriptUnavailable),
        };
        let canonical = fs::canonicalize(&path).map_err(|_| Reason::ScriptUnavailable)?;
        if !visited.insert(canonical.clone()) {
            continue;
        }
        if visited.len() > 32 {
            return Err(Reason::ScriptDynamic);
        }
        total += bytes.len();
        if total > 1024 * 1024 {
            return Err(Reason::ScriptUnavailable);
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| Reason::ScriptUnavailable)?;
        let tokens = cs2_frame_rate::lex(text, true).map_err(|_| Reason::ScriptUnavailable)?;
        for command in tokens
            .split(|t| !t.quoted && t.value == ";")
            .filter(|c| !c.is_empty())
        {
            let cmd = command[0].value.to_ascii_lowercase();
            commands.insert(cmd.clone());
            match cmd.as_str() {
                "bind" | "unbind" | "unbindall" | "binddefaults" | "writekeybindings"
                | "host_writeconfig" => return Err(Reason::ScriptConflict),
                "spec_usenumberkeys_nobinds" => return Err(Reason::ScriptConflict),
                "toggle" | "incrementvar"
                    if command.get(1).is_some_and(|v| {
                        v.value.eq_ignore_ascii_case("spec_usenumberkeys_nobinds")
                    }) =>
                {
                    return Err(Reason::ScriptConflict)
                }
                "exec_async" => return Err(Reason::ScriptDynamic),
                "exec" | "execifexists" => {
                    if command.len() != 2 {
                        return Err(Reason::ScriptDynamic);
                    }
                    pending.push((command[1].value.clone(), cmd == "execifexists"));
                }
                "alias" => {
                    let name = command.get(1).ok_or(Reason::ScriptDynamic)?;
                    aliases.insert(name.value.to_ascii_lowercase());
                }
                _ => (),
            }
        }
        fingerprints.push((canonical, hash(&bytes)));
    }
    if !aliases.is_disjoint(&commands) {
        return Err(Reason::ScriptDynamic);
    }
    fingerprints.sort();
    Ok(fingerprints)
}
fn cloud_mirrors(
    cfg: &Path,
    bytes: &[u8],
    reference: Option<&str>,
) -> Result<Vec<(PathBuf, String)>, Reason> {
    let app = cfg
        .parent()
        .and_then(Path::parent)
        .ok_or(Reason::Identity)?;
    let mut mirrors = Vec::new();
    for directory in [app.join("remote"), app.join("remote/cfg")] {
        match fs::symlink_metadata(&directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(Reason::Identity),
            Ok(m) if m.is_dir() => {
                spectator_snapshot::check_path(&directory, false).map_err(|_| Reason::Identity)?
            }
            _ => return Err(Reason::Identity),
        }
        let mut count = 0;
        for entry in fs::read_dir(&directory).map_err(|_| Reason::Identity)? {
            let entry = entry.map_err(|_| Reason::Identity)?;
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("cs2_user_keys") || !name.ends_with(".vcfg") {
                continue;
            }
            count += 1;
            if count > 32 {
                return Err(Reason::MultipleKeys);
            }
            let mirror = read(&entry.path(), 256 * 1024).map_err(|_| Reason::Identity)?;
            if reference.map_or_else(|| mirror != bytes, |expected| hash(&mirror) != expected) {
                return Err(Reason::MultipleKeys);
            }
            mirrors.push((
                fs::canonicalize(entry.path()).map_err(|_| Reason::Identity)?,
                hash(&mirror),
            ));
        }
    }
    mirrors.sort();
    Ok(mirrors)
}
pub(crate) fn inspect(video: &Path, exe: &Path, account: u32) -> Result<Eligible, Reason> {
    inspect_with_mirror(video, exe, account, None)
}
fn inspect_with_mirror(
    video: &Path,
    exe: &Path,
    account: u32,
    reference: Option<&str>,
) -> Result<Eligible, Reason> {
    let cfg = video.parent().ok_or(Reason::Identity)?;
    let slot = key_slot(cfg)?;
    let (value, key) =
        spectator_snapshot::identity(video, exe, account, slot).map_err(|_| Reason::Identity)?;
    let identity = ConfigIdentity::from_value(&value).map_err(|_| Reason::Identity)?;
    let bytes = read(&key, 256 * 1024).map_err(|_| Reason::InvalidKeys)?;
    key_format(&bytes)?;
    let mirrors = cloud_mirrors(cfg, &bytes, reference)?;
    let install = exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or(Reason::Identity)?;
    let defaults = default_resource::read_default(install).map_err(|_| Reason::DefaultSource)?;
    let scripts = script_guard(video, exe)?;
    let (after, _) =
        spectator_snapshot::identity(video, exe, account, slot).map_err(|_| Reason::Changed)?;
    let confirmed = default_resource::read_default(install).map_err(|_| Reason::Changed)?;
    if after != value
        || read(&key, 256 * 1024).map_err(|_| Reason::Changed)? != bytes
        || key_slot(cfg)? != slot
        || cloud_mirrors(cfg, &bytes, reference)? != mirrors
        || script_guard(video, exe)? != scripts
        || confirmed.sha256 != defaults.sha256
        || confirmed.source != defaults.source
        || confirmed.parser_version != defaults.parser_version
        || confirmed.source_identity != defaults.source_identity
    {
        return Err(Reason::Changed);
    }
    let fingerprint = Fingerprint {
        identity,
        key_sha256: hash(&bytes),
        default_sha256: defaults.sha256.clone(),
        source: format!("{:?}:{}", defaults.source, defaults.parser_version),
        source_identity: defaults.source_identity.clone(),
        scripts,
        mirrors,
    };
    Ok(Eligible {
        fingerprint,
        defaults,
    })
}
/// Build a candidate only from the frozen installed defaults and known ten-key
/// overlay. Existing spelling is preserved to avoid creating case aliases.
pub(crate) fn build_plan(
    eligible: &Eligible,
    original: &str,
) -> Result<
    (
        BTreeSet<crate::spectator_recovery_plan::Input>,
        crate::spectator_recovery_plan::Bindings,
        String,
    ),
    Reason,
> {
    use crate::spectator_recovery_plan::{Bindings, Input, InputKind};
    if hash(original.as_bytes()) != eligible.fingerprint.key_sha256 {
        return Err(Reason::Changed);
    }
    let before = crate::spectator_recovery_vcfg::parse_bindings(original)
        .map_err(|_| Reason::InvalidKeys)?;
    let mut spelling = BTreeMap::new();
    for field in before.keys() {
        let key = (field.kind.clone(), field.name.to_ascii_lowercase());
        if let Some(previous) = spelling.insert(key, field.name.clone()) {
            if previous != field.name {
                return Err(Reason::InvalidKeys);
            }
        }
    }
    let mut expected = Bindings::new();
    for (kind, defaults) in [
        (InputKind::Key, &eligible.defaults.bindings),
        (InputKind::Axis, &eligible.defaults.analogbindings),
    ] {
        for (name, command) in defaults {
            let chosen = spelling
                .get(&(kind.clone(), name.to_ascii_lowercase()))
                .cloned()
                .unwrap_or_else(|| name.clone());
            expected.insert(
                Input {
                    kind: kind.clone(),
                    name: chosen,
                },
                vec![command.clone()],
            );
        }
    }
    for (key, command) in [
        ("1", "slot1"),
        ("2", "slot2"),
        ("3", "slot3"),
        ("4", "slot4"),
        ("5", "slot5"),
        ("6", "slot6"),
        ("7", "slot7"),
        ("8", "slot8"),
        ("9", "slot9"),
        ("0", "slot10"),
    ] {
        if !eligible.defaults.bindings.contains_key(key) {
            return Err(Reason::DefaultSource);
        }
        let chosen = spelling
            .get(&(InputKind::Key, key.to_string()))
            .cloned()
            .unwrap_or_else(|| key.to_string());
        expected.insert(
            Input {
                kind: InputKind::Key,
                name: chosen,
            },
            vec![command.into()],
        );
    }
    let owned: BTreeSet<Input> = before.keys().chain(expected.keys()).cloned().collect();
    if owned.is_empty() || owned.len() > 1024 {
        return Err(Reason::InvalidKeys);
    }
    fn quote(value: &str) -> Result<String, Reason> {
        if value.chars().any(char::is_control) {
            return Err(Reason::InvalidKeys);
        }
        Ok(format!(
            "\"{}\"",
            value.replace('\\', "\\\\").replace('\"', "\\\"")
        ))
    }
    let mut candidate = String::from("\"config\" {\"bindings\" {");
    for (field, values) in &expected {
        if field.kind == InputKind::Key {
            candidate.push_str(&format!(" {} {}", quote(&field.name)?, quote(&values[0])?));
        }
    }
    candidate.push_str(" } \"analogbindings\" {");
    for (field, values) in &expected {
        if field.kind == InputKind::Axis {
            candidate.push_str(&format!(" {} {}", quote(&field.name)?, quote(&values[0])?));
        }
    }
    candidate.push_str(" }}");
    crate::spectator_recovery_vcfg::plan_application(original, &candidate, &expected, &owned)
        .map_err(|_| Reason::InvalidKeys)?;
    Ok((owned, expected, candidate))
}

pub(crate) fn revalidate(
    previous: &Fingerprint,
    video: &Path,
    exe: &Path,
    account: u32,
) -> Result<Eligible, Reason> {
    let next = inspect(video, exe, account)?;
    if next.fingerprint != *previous {
        return Err(Reason::Changed);
    }
    Ok(next)
}

/// Recheck after the core transaction's own known script writes, without
/// treating those exact changes as external edits.
pub(crate) fn revalidate_after_core(
    previous: &Fingerprint,
    video: &Path,
    exe: &Path,
    account: u32,
    frames: &[(&Path, &str, &str)],
) -> Result<(), Reason> {
    let mut expected = previous.clone();
    for (path, _, applied) in frames {
        let canonical = fs::canonicalize(path).map_err(|_| Reason::Changed)?;
        if let Some((_, digest)) = expected
            .scripts
            .iter_mut()
            .find(|(script, _)| *script == canonical)
        {
            *digest = hash(applied.as_bytes());
        }
    }
    let current = inspect(video, exe, account)?;
    if current.fingerprint != expected {
        return Err(Reason::Changed);
    }
    Ok(())
}

/// Recheck the exact expected key output and the frozen source immediately
/// before the Steam request; Cloud mirrors remain compared to their original.
pub(crate) fn verify_for_launch(
    previous: &Fingerprint,
    applied_sha256: &str,
    video: &Path,
    exe: &Path,
    account: u32,
    frames: &[(&Path, &str, &str)],
) -> Result<(), Reason> {
    let mut expected = previous.clone();
    expected.key_sha256 = applied_sha256.to_string();
    for (path, _, applied) in frames {
        let canonical = fs::canonicalize(path).map_err(|_| Reason::Changed)?;
        if let Some((_, digest)) = expected
            .scripts
            .iter_mut()
            .find(|(script, _)| *script == canonical)
        {
            *digest = hash(applied.as_bytes());
        }
    }
    let current = inspect_with_mirror(video, exe, account, Some(&previous.key_sha256))?;
    if current.fingerprint != expected {
        return Err(Reason::Changed);
    }
    Ok(())
}
