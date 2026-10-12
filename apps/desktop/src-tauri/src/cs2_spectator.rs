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
    let path = cfg_path(executable)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || ![CFG.len() as u64, LEGACY_CFG.len() as u64].contains(&metadata.len())
            {
                return Err(
                    "同名 mizar_observer.cfg 不属于当前固定配置，已保留原文件，未加载观战预设。"
                        .into(),
                );
            }
            let bytes = fs::read(&path).map_err(|error| io_error("无法核实观战 CFG。", &error))?;
            if bytes == LEGACY_CFG {
                crate::cs2_session::atomic_write(&path, CFG)?;
            } else if bytes != CFG {
                return Err(
                    "同名 mizar_observer.cfg 不属于当前固定配置，已保留原文件，未加载观战预设。"
                        .into(),
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| io_error("观战 CFG 无法部署，未加载观战预设。", &error))?;
            file.write_all(CFG)
                .and_then(|_| file.sync_all())
                .map_err(|error| io_error("观战 CFG 未能完整保存，未加载观战预设。", &error))?;
            if fs::read(&path).map_err(|error| io_error("观战 CFG 无法读回核实。", &error))? != CFG
            {
                return Err("观战 CFG 读回不一致，未加载观战预设。".into());
            }
        }
        Err(error) => return Err(io_error("无法核实观战 CFG，未加载观战预设。", &error)),
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
    let bindings = backup_bindings(&read_keys(video)?)?;
    install(executable)?;
    // Runtime +exec selects weapon-slot bindings even when the original was true. Do not
    // prewrite this archive field or change FPS's original/applied contract.
    Ok(
        json!({"version":2,"video":video,"original":original,"bindings":bindings,"loadAttempted":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_both_original_boolean_states_preserving_other_game_edits() {
        for token in ["true", "1", "false", "0"] {
            let original = format!("\"config\" {{\"convars\" {{\"{KEY}\" \"{token}\"}}}}");
            for applied in [false, true] {
                let applied_token = if applied { "true" } else { "0" };
                let current = format!("\"config\" {{\"convars\" {{\"{KEY}\" \"{applied_token}\" \"other\" \"new\"}}}}");
                assert_eq!(
                    restore_with_applied(&original, &current, applied).unwrap(),
                    current.replace(&format!("\"{applied_token}\""), &format!("\"{token}\""))
                );
                if applied {
                    assert_eq!(
                        restore(&original, &current).unwrap(),
                        current.replace("\"true\"", &format!("\"{token}\""))
                    );
                }
            }
        }
        let original = format!("\"config\" {{\"convars\" {{\"{KEY}\" \"false\"}}}}");
        assert!(
            restore_with_applied(&original, &original.replace("false", "true"), false).is_err()
        );
    }






}
