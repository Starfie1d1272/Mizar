//! Optional spectator preset. Own only number keys and the existing spectator field.
use crate::{cs2_frame_rate::field, cs2_session::io_error};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const KEY: &str = "spec_usenumberkeys_nobinds";

fn value(text: &str) -> Result<crate::cs2_frame_rate::Token, String> {
    let token = field(text, &["config", "convars", KEY])?
        .ok_or("未找到原始数字键观战设置，数字键预设未应用；个人绑定保持原样。")?;
    boolean(&token.value)?;
    Ok(token)
}

fn boolean(value: &str) -> Result<bool, String> {
    match value {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err("原始数字键观战设置无法可靠读取，数字键预设未应用。".into()),
    }
}

pub const CFG_NAME: &str = "mizar_observer.cfg";
const CFG: &[u8] = include_bytes!("../../../../config/mizar_observer.cfg");
const HUD_COMMAND: &str = "toggle cl_draw_only_deathnotices 0 1";
const HUD_LINE: &str = "bind \"h\" \"toggle cl_draw_only_deathnotices 0 1\"\n";

pub fn hud_cfg_name(identity: &str) -> Result<&'static str, String> {
    match identity {
        "h" | "scancode11" => Ok(CFG_NAME),
        _ => Err("HUD 键身份无法核实。".into()),
    }
}

fn config_for(identity: Option<&str>) -> Result<Vec<u8>, String> {
    let source = std::str::from_utf8(CFG).map_err(|_| "观战 CFG 格式无效。")?;
    if source.matches(HUD_LINE).count() != 1 {
        return Err("观战 CFG 格式无效。".into());
    }
    let replacement = match identity {
        None => String::new(),
        Some("h") => HUD_LINE.to_string(),
        Some("scancode11") => HUD_LINE.replace("\"h\"", "\"scancode11\""),
        _ => return Err("HUD 键身份无法核实。".into()),
    };
    Ok(source.replace(HUD_LINE, &replacement).into_bytes())
}

const LEGACY_CFG: &[u8] = b"// Mizar managed spectator session; personal bindings remain unchanged.\nspec_usenumberkeys_nobinds 1\necho MIZAR_OBSERVER_CFG_LOADED\n";
const KEYS_NAME: &str = "cs2_user_keys_0_slot0.vcfg";
const NUMBER_BINDINGS: [(&str, &str); 10] = [
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
];

pub(crate) fn cfg_path(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|game| game.join("csgo/cfg").join(CFG_NAME))
        .ok_or_else(|| "观战 CFG 目录无法核实。".into())
}

/// Create our fixed file, accept identical bytes, or upgrade the exact old file.
/// Never replace an
/// unknown file, including a symlink or a partially written previous install.
pub fn install(executable: &Path) -> Result<(), String> {
    install_config(executable, None)
}

pub fn install_hud(executable: &Path, identity: &str) -> Result<(), String> {
    hud_cfg_name(identity)?;
    install_config(executable, Some(identity))
}

fn install_config(executable: &Path, identity: Option<&str>) -> Result<(), String> {
    let path = cfg_path(executable)?;
    let expected = config_for(identity)?;
    let known = [
        config_for(None)?,
        config_for(Some("h"))?,
        config_for(Some("scancode11"))?,
        LEGACY_CFG.to_vec(),
    ];
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || !known
                    .iter()
                    .any(|bytes| bytes.len() as u64 == metadata.len())
            {
                return Err("同名 mizar_observer.cfg 不属于固定配置，已保留原文件。".into());
            }
            let bytes = fs::read(&path).map_err(|error| io_error("无法核实观战 CFG。", &error))?;
            if !known.contains(&bytes) {
                return Err("同名 mizar_observer.cfg 不属于固定配置，已保留原文件。".into());
            }
            if bytes != expected {
                if fs::read(&path).map_err(|error| io_error("无法复核观战 CFG。", &error))? != bytes
                {
                    return Err("观战 CFG 在部署期间已变化，原文件保留。".into());
                }
                crate::cs2_session::atomic_write(&path, &expected)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| io_error("观战 CFG 无法部署。", &error))?;
            file.write_all(&expected)
                .and_then(|_| file.sync_all())
                .map_err(|error| io_error("观战 CFG 未能完整保存。", &error))?;
            if fs::read(&path).map_err(|error| io_error("观战 CFG 无法读回核实。", &error))?
                != expected
            {
                return Err("观战 CFG 读回不一致。".into());
            }
        }
        Err(error) => return Err(io_error("无法核实观战 CFG。", &error)),
    }
    Ok(())
}

/// Verify exact managed bytes immediately before submitting a launch.
pub(crate) fn validate_installed(executable: &Path, identity: Option<&str>) -> Result<(), String> {
    let path = cfg_path(executable)?;
    let expected = config_for(identity)?;
    let metadata = fs::symlink_metadata(&path).map_err(|e| io_error("观战 CFG 无法核实。", &e))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != expected.len() as u64
        || fs::read(&path).map_err(|e| io_error("观战 CFG 无法核实。", &e))? != expected
    {
        return Err("观战 CFG 已变化，未提交启动。".into());
    }
    Ok(())
}

fn keys_path(video: &Path) -> Result<PathBuf, String> {
    Ok(video.parent().ok_or("按键配置目录缺失。")?.join(KEYS_NAME))
}

fn read_keys(video: &Path) -> Result<String, String> {
    let path = keys_path(video)?;
    let local = path.parent().ok_or("按键配置目录缺失。")?;
    let account_app = local
        .parent()
        .and_then(Path::parent)
        .ok_or("按键配置位置无法核实。")?;
    if local.file_name().is_none_or(|name| name != "cfg")
        || local
            .parent()
            .and_then(Path::file_name)
            .is_none_or(|name| name != "local")
        || account_app.file_name().is_none_or(|name| name != "730")
    {
        return Err("按键配置位置无法核实。".into());
    }
    for directory in [local, local.parent().unwrap(), account_app] {
        let metadata =
            fs::symlink_metadata(directory).map_err(|e| io_error("按键配置目录无法核实。", &e))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("按键配置目录无法安全核实。".into());
        }
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|e| io_error("数字键原绑定无法读取，备份仍保留；请先运行一次 CS2。", &e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
        return Err("数字键配置无法安全核实，备份仍保留。".into());
    }
    let text =
        fs::read_to_string(&path).map_err(|e| io_error("数字键配置无法读取，备份仍保留。", &e))?;
    if text.len() > 256 * 1024 {
        return Err("数字键配置过大，备份仍保留。".into());
    }
    Ok(text)
}

type Entry = (crate::cs2_frame_rate::Token, crate::cs2_frame_rate::Token);

fn binding_entries(text: &str) -> Result<Vec<Entry>, String> {
    let entries = crate::cs2_frame_rate::scalar_section(text, &["config", "bindings"])?;
    for (digit, _) in NUMBER_BINDINGS {
        let mut values = entries
            .iter()
            .filter(|(key, _)| key.value == digit)
            .map(|(_, value)| &value.value);
        if let Some(first) = values.next() {
            if values.any(|other| other != first) {
                return Err("数字键配置包含不同命令的重复字段，备份仍保留。".into());
            }
        }
    }
    Ok(entries)
}

fn backup_bindings(text: &str) -> Result<Value, String> {
    let entries = binding_entries(text)?;
    let mut saved = serde_json::Map::new();
    for (digit, _) in NUMBER_BINDINGS {
        let token = entries
            .iter()
            .find(|(key, _)| key.value == digit)
            .map(|(_, value)| text[value.start..value.end].to_string());
        saved.insert(digit.to_string(), json!(token));
    }
    Ok(Value::Object(saved))
}

fn saved_binding(saved: &Value, digit: &str) -> Result<Option<(String, String)>, String> {
    match saved.get(digit) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => {
            // Validate the saved token as one quoted scalar, never as commands.
            let text = format!("\"config\" {{\"bindings\" {{\"{digit}\" {raw}}}}}");
            let token = field(&text, &["config", "bindings", digit])?
                .filter(|token| token.end - token.start == raw.len())
                .ok_or("数字键原命令备份无法核实。")?;
            Ok(Some((raw.clone(), token.value)))
        }
        _ => Err("数字键原命令备份缺失或损坏。".into()),
    }
}

pub fn validate_bindings(video: &Path, saved: &Value) -> Result<(), String> {
    if backup_bindings(&read_keys(video)?)? != *saved {
        return Err("数字键绑定在准备期间发生变化，未加载观战 CFG。".into());
    }
    Ok(())
}

/// Patch only number keys in the current file, preserving all other game edits.
fn restored_bindings(saved: &Value, current: &str) -> Result<String, String> {
    if saved
        .as_object()
        .is_none_or(|object| object.len() != NUMBER_BINDINGS.len())
    {
        return Err("数字键备份格式无法核实。".into());
    }
    let entries = binding_entries(current)?;
    let mut edits = Vec::new();
    for (digit, applied) in NUMBER_BINDINGS {
        let original = saved_binding(saved, digit)?;
        let matches: Vec<_> = entries
            .iter()
            .filter(|(key, _)| key.value == digit)
            .collect();
        let now = matches.first().map(|(_, value)| value.value.as_str());
        if now == original.as_ref().map(|(_, value)| value.as_str()) {
            continue; // Already restored, or +exec was never applied.
        }
        if now != Some(applied) {
            return Err(format!(
                "数字键 {digit} 已被外部修改，未覆盖该修改；原绑定备份仍保留。"
            ));
        }
        for (key, value) in matches {
            edits.push(match &original {
                Some((raw, _)) => (value.start, value.end, raw.clone()),
                None => (key.start, value.end, String::new()),
            });
        }
    }
    edits.sort_by_key(|(start, _, _)| *start);
    let mut restored = current.to_string();
    for (start, end, replacement) in edits.into_iter().rev() {
        restored.replace_range(start..end, &replacement);
    }
    Ok(restored)
}

pub fn restore_bindings(video: &Path, saved: &Value) -> Result<(), String> {
    let current = read_keys(video)?;
    let restored = restored_bindings(saved, &current)?;
    if restored != current {
        // Refuse an intervening file edit instead of replacing its newer bytes.
        if read_keys(video)? != current {
            return Err("数字键配置在恢复期间发生变化，备份仍保留。".into());
        }
        crate::cs2_session::atomic_write(&keys_path(video)?, restored.as_bytes())?;
    }
    Ok(())
}

/// A missing explicit binding uses the standard physical H scancode; aliases are never inferred.
fn backup_hud(text: &str) -> Result<Value, String> {
    let entries = binding_entries(text)?;
    let mut candidates = serde_json::Map::new();
    let mut selected = None;
    for name in ["h", "scancode11"] {
        let matches: Vec<_> = entries
            .iter()
            .filter(|(key, _)| key.value.eq_ignore_ascii_case(name))
            .collect();
        if matches.len() > 1 || matches.first().is_some_and(|(key, _)| key.value != name) {
            return Err("HUD 键身份重复或大小写不确定，未应用绑定。".into());
        }
        let token = matches
            .first()
            .map(|(_, value)| text[value.start..value.end].to_string());
        if token.is_some() {
            if selected.is_some() {
                return Err("HUD 键候选存在冲突，未应用绑定。".into());
            }
            selected = Some(name);
        }
        candidates.insert(name.to_string(), json!(token));
    }
    let identity = selected.unwrap_or("scancode11");
    Ok(json!({"identity":identity,"candidates":candidates,"originalKeys":text}))
}

fn restore_hud(saved: &Value, current: &str) -> Result<String, String> {
    let identity = saved["identity"].as_str().ok_or("HUD 键身份备份缺失。")?;
    hud_cfg_name(identity)?;
    let original_text = saved["originalKeys"]
        .as_str()
        .ok_or("HUD 原始键位备份缺失。")?;
    if original_text.len() > 256 * 1024 || backup_hud(original_text)? != *saved {
        return Err("HUD 原始键位备份无法核实。".into());
    }
    let entries = binding_entries(current)?;
    let other = if identity == "h" { "scancode11" } else { "h" };
    // An added or renamed candidate is a conflict, even if its command looks like ours.
    if entries
        .iter()
        .any(|(key, _)| key.value.eq_ignore_ascii_case(other))
    {
        return Err("HUD 键候选已变化，原绑定备份仍保留。".into());
    }
    let matches: Vec<_> = entries
        .iter()
        .filter(|(key, _)| key.value.eq_ignore_ascii_case(identity))
        .collect();
    if matches.len() > 1
        || matches
            .first()
            .is_some_and(|(key, _)| key.value != identity)
    {
        return Err("HUD 键重复或身份变化，原绑定备份仍保留。".into());
    }
    let original = saved_binding(&saved["candidates"], identity)?;
    let current_value = matches.first().map(|(_, value)| value.value.as_str());
    if current_value == original.as_ref().map(|(_, value)| value.as_str()) {
        return Ok(current.to_string());
    }
    if current_value != Some(HUD_COMMAND) {
        return Err("HUD 键已被外部修改或缺失，原绑定备份仍保留。".into());
    }
    let (key, value) = matches[0];
    let mut result = current.to_string();
    match original {
        Some((raw, _)) => result.replace_range(value.start..value.end, &raw),
        None => result.replace_range(key.start..value.end, ""),
    }
    Ok(result)
}

pub fn validate_hud(video: &Path, saved: &Value) -> Result<(), String> {
    if backup_hud(&read_keys(video)?)? != *saved {
        return Err("HUD 键绑定在准备期间发生变化。".into());
    }
    Ok(())
}

pub fn restore_v3_bindings(video: &Path, bindings: &Value, hud: &Value) -> Result<(), String> {
    let current = read_keys(video)?;
    let restored = restore_hud(hud, &restored_bindings(bindings, &current)?)?;
    if restored != current {
        if read_keys(video)? != current {
            return Err("按键配置在恢复期间发生变化，备份仍保留。".into());
        }
        crate::cs2_session::atomic_write(&keys_path(video)?, restored.as_bytes())?;
    }
    Ok(())
}

pub fn restore(original: &str, current: &str) -> Result<String, String> {
    restore_with_applied(original, current, true)
}

pub fn restore_with_applied(
    original: &str,
    current: &str,
    applied: bool,
) -> Result<String, String> {
    let before = value(original).map_err(|_| "原观战字段备份无法核实。")?;
    let now = value(current).map_err(|_| "当前观战字段缺失、重复或值异常，原值备份仍保留。")?;
    if boolean(&now.value)? != boolean(&before.value)? && boolean(&now.value)? != applied {
        return Err("观战字段已被外部修改，未覆盖外部修改；原值备份仍保留。".into());
    }
    let mut restored = current.to_string();
    restored.replace_range(now.start..now.end, &original[before.start..before.end]);
    Ok(restored)
}

/// Bounded, read-only eligibility check before launch only. Never part of FPS
/// or video recovery; newly appearing mirrors remain untouched.
pub fn check_archive(video: &Path) -> Result<(), String> {
    let local = video.parent().ok_or("观战配置目录缺失。")?;
    let app = local
        .parent()
        .and_then(Path::parent)
        .ok_or("观战配置目录缺失。")?;
    if local.file_name().is_none_or(|v| v != "cfg")
        || local
            .parent()
            .and_then(Path::file_name)
            .is_none_or(|v| v != "local")
        || app.file_name().is_none_or(|v| v != "730")
    {
        return Err("观战配置位置无法核实，数字键预设未应用。".into());
    }
    let machine = local.join("cs2_machine_convars.vcfg");
    let mut count = 0;
    let mut total = 0;
    for directory in [
        local.to_path_buf(),
        app.join("remote"),
        app.join("remote/cfg"),
    ] {
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(io_error(
                    "观战配置镜像无法安全核实，数字键预设未应用。",
                    &error,
                ))
            }
            Ok(_) => return Err("观战配置镜像无法安全核实，数字键预设未应用。".into()),
        };
        for entry in
            fs::read_dir(&directory).map_err(|error| io_error("无法核实观战配置镜像。", &error))?
        {
            let entry = entry.map_err(|error| io_error("无法核实观战配置镜像。", &error))?;
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.contains("convars") || !name.contains(".vcfg") {
                continue;
            }
            count += 1;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| io_error("无法读取观战配置镜像。", &error))?;
            if count > 32
                || !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 256 * 1024
            {
                return Err("观战配置镜像无法安全核实，数字键预设未应用。".into());
            }
            let text = fs::read_to_string(entry.path())
                .map_err(|error| io_error("无法读取观战配置镜像。", &error))?;
            total += text.len();
            if text.len() > 256 * 1024 || total > 1024 * 1024 {
                return Err("观战配置镜像过大，数字键预设未应用。".into());
            }
            if entry.path() != machine
                && text.to_ascii_lowercase().contains(KEY)
                && field(&text, &["config", "convars", KEY])
                    .map_err(|_| "观战配置镜像字段无法可靠解析。")?
                    .is_some()
            {
                return Err(
                    "发现数字键观战设置的用户或云镜像，未接管该设置；个人绑定保持原样。".into(),
                );
            }
        }
    }
    Ok(())
}

/// Full-key mode does not own the spectator convar; only use it when the
/// archived value already selects slot bindings and no mirror conflicts.
pub(crate) fn full_mode_convar_compatible(files: &[Value], video: &Path) -> Result<(), String> {
    check_archive(video)?;
    let original = files
        .first()
        .filter(|record| record["kind"] == "convars")
        .and_then(|record| record["original"].as_str())
        .ok_or("观战设置无法确认，使用基础观战模式。")?;
    let token = value(original).map_err(|_| "观战设置无法确认，使用基础观战模式。")?;
    if boolean(&token.value)? {
        return Err("当前数字键观战设置需要单独接管，使用基础观战模式。".into());
    }
    Ok(())
}

/// Preserve FPS/video values; startup CFGs only receive a temporary final exec.
pub(crate) fn prepare_standalone(video: &Path, executable: &Path) -> Result<Value, String> {
    check_archive(video)?;
    let path = video
        .parent()
        .ok_or("观战配置目录缺失。")?
        .join("cs2_machine_convars.vcfg");
    let metadata = fs::symlink_metadata(&path).map_err(|e| io_error("观战配置无法读取。", &e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
        return Err("观战配置无法安全核实。".into());
    }
    let original = fs::read_to_string(&path).map_err(|e| io_error("观战配置无法读取。", &e))?;
    if original.len() > 256 * 1024 {
        return Err("观战配置过大。".into());
    }
    value(&original)?;
    let mut record = prepare(
        &[json!({"kind":"convars", "original":original})],
        video,
        executable,
    )?;
    record["executable"] = json!(executable);
    record["startupFiles"] = json!(crate::cs2_frame_rate::prepare_observer_scripts(video, executable)?);
    Ok(record)
}

pub(crate) enum StartupFiles { Apply, Validate, Restore }

/// Uses the spectator journal's original bytes; no additional recovery owner.
pub(crate) fn startup_files(record: &Value, action: StartupFiles) -> Result<(), String> {
    let Some(files) = record.get("startupFiles") else { return Ok(()); };
    let files = files.as_array().filter(|files| files.len() <= 32).ok_or("观战启动配置记录无效。")?;
    let video = Path::new(record["video"].as_str().ok_or("观战配置路径缺失。")?);
    let executable = Path::new(record["executable"].as_str().ok_or("观战程序路径缺失。")?);
    if !video.is_absolute() || !executable.is_absolute() { return Err("观战启动配置路径无效。".into()); }
    let mut unique = std::collections::BTreeSet::new();
    let mut plan = Vec::new();
    for entry in files {
        if entry["kind"] != "cfg" { return Err("观战启动配置范围无效。".into()); }
        let (path, original, applied) = crate::cs2_frame_rate::validated_script(entry, video, executable, None)?;
        let canonical = fs::canonicalize(path).map_err(|e| io_error("观战启动配置无法确认。", &e))?;
        if !unique.insert(canonical.to_string_lossy().to_lowercase()) { return Err("观战启动配置路径重复。".into()); }
        let metadata = fs::metadata(path).map_err(|e| io_error("观战启动配置无法读取。", &e))?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 { return Err("观战启动配置类型或大小已变化。".into()); }
        let current = fs::read_to_string(path).map_err(|e| io_error("观战启动配置无法读取。", &e))?;
        let target = match action {
            StartupFiles::Apply if current == original => applied,
            StartupFiles::Validate if current == applied => applied,
            StartupFiles::Restore if current == original || current == applied => original,
            _ => return Err("观战启动配置已被修改，原文件备份仍保留，请检查后重试。".into()),
        };
        plan.push((path, current, target));
    }
    for (path, current, target) in plan {
        if fs::read_to_string(path).map_err(|e| io_error("观战启动配置无法复核。", &e))? != current {
            return Err("观战启动配置在操作期间发生变化，备份仍保留。".into());
        }
        if current != target { crate::cs2_session::atomic_write(path, target.as_bytes())?; }
    }
    Ok(())
}

pub fn prepare(files: &[Value], video: &Path, executable: &Path) -> Result<Value, String> {
    check_archive(video)?;
    let record = files
        .first()
        .filter(|record| record["kind"] == "convars")
        .ok_or("观战配置备份缺失。")?;
    let original = record["original"]
        .as_str()
        .ok_or("观战配置原值备份缺失。")?;
    value(original)?;
    let keys = read_keys(video)?;
    let bindings = backup_bindings(&keys)?;
    match backup_hud(&keys) {
        Ok(hud) => {
            let identity = hud["identity"].as_str().ok_or("HUD 键身份缺失。")?;
            match install_hud(executable, identity) {
                Ok(()) => Ok(
                    json!({"version":3,"video":video,"original":original,"bindings":bindings,"hud":hud,"loadAttempted":false}),
                ),
                Err(warning) => Err(warning),
            }
        }
        Err(warning) => {
            install(executable)?;
            Ok(
                json!({"version":2,"video":video,"original":original,"bindings":bindings,"hudWarning":warning,"loadAttempted":false}),
            )
        }
    }
}
