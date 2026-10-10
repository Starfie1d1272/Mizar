//! Optional raw-number-key preset. Never own or rewrite personal key bindings.
use crate::cs2_frame_rate::field;
use serde_json::{json, Value};
use std::{fs, path::Path};

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

/// First version only confirms an already-enabled machine field. It does not
/// own archive writes: cloud scope has not yet been verified on current CS2.
pub fn already_enabled(text: &str) -> Result<(), String> {
    if boolean(&value(text)?.value)? {
        Ok(())
    } else {
        Err(
            "原数字键观战设置未启用，本次预设未应用。可在 CS2 中确认该设置，或选择保留原设置。"
                .into(),
        )
    }
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
            _ => return Err("观战配置镜像无法安全核实，数字键预设未应用。".into()),
        };
        for entry in fs::read_dir(&directory).map_err(|_| "无法核实观战配置镜像。")? {
            let entry = entry.map_err(|_| "无法核实观战配置镜像。")?;
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.contains("convars") || !name.contains(".vcfg") {
                continue;
            }
            count += 1;
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| "无法读取观战配置镜像。")?;
            if count > 32
                || !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 256 * 1024
            {
                return Err("观战配置镜像无法安全核实，数字键预设未应用。".into());
            }
            let text = fs::read_to_string(entry.path()).map_err(|_| "无法读取观战配置镜像。")?;
            total += text.len();
            if text.len() > 256 * 1024 || total > 1024 * 1024 {
                return Err("观战配置镜像过大，数字键预设未应用。".into());
            }
            if name == "cs2_machine_convars.vcfg_lastclouded"
                || (entry.path() != machine && text.to_ascii_lowercase().contains(KEY))
            {
                return Err(
                    "发现数字键观战设置的用户或云镜像，未接管该设置；个人绑定保持原样。".into(),
                );
            }
        }
    }
    Ok(())
}

pub fn prepare(files: &mut [Value], video: &Path) -> Result<(), String> {
    check_archive(video)?;
    let record = files
        .first_mut()
        .filter(|record| record["kind"] == "convars")
        .ok_or("观战配置备份缺失，数字键预设未应用。")?;
    if record["spectatorStartupConflict"] == true {
        return Err("启动项或 CFG 已设置数字键观战模式，未覆盖个人配置；数字键预设未应用。".into());
    }
    let original = record["original"]
        .as_str()
        .ok_or("观战配置原值备份缺失。")?;
    already_enabled(original)?;
    record["spectatorNumberKeys"] = json!(true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_already_enabled_archive_values_without_mutating_them() {
        for token in ["true", "1", "false", "0"] {
            let original = format!("\"config\" {{\"convars\" {{\"{KEY}\" \"{token}\"}}}}");
            assert_eq!(
                already_enabled(&original).is_ok(),
                matches!(token, "true" | "1")
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
            assert!(already_enabled(&text).is_err());
        }
    }
}
