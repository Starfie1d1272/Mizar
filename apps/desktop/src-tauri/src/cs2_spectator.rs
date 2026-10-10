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

pub fn apply(text: &str) -> Result<String, String> {
    let token = value(text)?;
    let mut result = text.to_string();
    result.replace_range(token.start..token.end, "\"true\"");
    Ok(result)
}

pub fn restore(original: &str, current: &str) -> Result<String, String> {
    let before = value(original).map_err(|_| "原始观战配置无法核实，备份仍保留。")?;
    let now = value(current).map_err(|_| "当前观战配置缺失或无法核实，备份仍保留。")?;
    // Only the original value or our applied true is attributable to this
    // transaction. Unknown values / a missing field keep the journal pending.
    let now_value = boolean(&now.value)?;
    if now_value != boolean(&before.value)? && !now_value {
        return Err("数字键观战设置已被外部修改，原值备份仍保留。".into());
    }
    let mut result = current.to_string();
    result.replace_range(now.start..now.end, &original[before.start..before.end]);
    Ok(result)
}

/// Supported scope is a pre-existing machine field in the selected account.
/// Mirrored / per-user copies are deliberately not taken over. Check again on
/// recovery, so newly discovered copies cannot lead to a false success report.
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
    value(original)?;
    let applied = apply(record["applied"].as_str().ok_or("观战配置应用记录缺失。")?)?;
    record["applied"] = json!(applied);
    record["spectatorNumberKeys"] = json!(true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_exact_source_token_without_owning_bindings_or_other_convars() {
        for original_value in ["false", "0", "true", "1"] {
            let original = format!("\u{feff}\"config\" {{ \"convars\" {{ // keep\r\n\"{KEY}\" \"{original_value}\" \"other\" \"old\" }} }}");
            let applied = apply(&original).unwrap();
            assert_eq!(restore(&original, &applied).unwrap(), original);
            let current = applied
                .replace("\"old\"", "\"new\"")
                .replace("\"true\"", "\"1\"");
            assert_eq!(
                restore(&original, &current).unwrap(),
                original.replace("\"old\"", "\"new\"")
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
            assert!(apply(&text).is_err());
        }
        let original = format!("\"config\" {{\"convars\" {{\"{KEY}\" \"false\"}}}}");
        assert!(restore(&original, "\"config\" {\"convars\" {}}").is_err());
    }
}
