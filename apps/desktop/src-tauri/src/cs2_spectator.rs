//! Optional raw-number-key preset. Never own or rewrite personal key bindings.
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

pub(crate) fn cfg_path(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|game| game.join("csgo/cfg").join(CFG_NAME))
        .ok_or_else(|| "观战 CFG 目录无法核实。".into())
}

/// Only create our fixed file, or accept identical bytes. Never replace an
/// unknown file, including a symlink or a partially written previous install.
pub fn install(executable: &Path) -> Result<(), String> {
    let path = cfg_path(executable)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != CFG.len() as u64
                || fs::read(&path).map_err(|error| io_error("无法核实观战 CFG。", &error))? != CFG
            {
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

pub fn restore(original: &str, current: &str) -> Result<String, String> {
    let before = value(original).map_err(|_| "原观战字段备份无法核实。")?;
    let now = value(current).map_err(|_| "当前观战字段缺失、重复或值异常，原值备份仍保留。")?;
    if !boolean(&now.value)? && boolean(&before.value)? {
        return Err("观战字段已被外部关闭，未覆盖外部修改；原值备份仍保留。".into());
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
    install(executable)?;
    // Runtime +exec will enable true even when the original was false. Do not
    // prewrite this archive field or change FPS's original/applied contract.
    Ok(json!({"version":1,"video":video,"original":original}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_both_original_boolean_states_preserving_other_game_edits() {
        for token in ["true", "1", "false", "0"] {
            let original = format!("\"config\" {{\"convars\" {{\"{KEY}\" \"{token}\"}}}}");
            let current =
                format!("\"config\" {{\"convars\" {{\"{KEY}\" \"true\" \"other\" \"new\"}}}}");
            assert_eq!(
                restore(&original, &current).unwrap(),
                current.replace("\"true\"", &format!("\"{token}\""))
            );
        }
    }

    #[test]
    fn absent_duplicate_and_unreadable_values_are_not_invented() {
        for text in [
            "\"config\" {\"convars\" {}}".to_string(),
            format!("\"config\" {{\"convars\" {{\"{KEY}\" \"false\" \"{KEY}\" \"true\"}}}}"),
            format!("\"config\" {{\"convars\" {{\"{KEY}\" \"unknown\"}}}}"),
        ] {
            assert!(value(&text).is_err());
        }
    }
}
