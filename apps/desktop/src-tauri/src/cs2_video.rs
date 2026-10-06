//! Lossless edits of the flat video.cfg object. Unknown fields and comments survive.
use std::collections::BTreeMap;

pub const DISPLAY_WIDTH: &str = "1920";
pub const DISPLAY_HEIGHT: &str = "1080";

#[derive(Debug)]
struct Token {
    value: String,
    start: usize,
    end: usize,
    key_start: usize,
}

fn tokens(text: &str) -> Result<Vec<Token>, String> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut i = if text.starts_with('\u{feff}') { 3 } else { 0 };
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        let start = i;
        if bytes[i] == b'"' {
            i += 1;
            let value_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' {
                    return Err("视频配置包含不支持的转义格式。".into());
                }
                i += 1;
            }
            if i == bytes.len() {
                return Err("视频配置不完整。".into());
            }
            let value = text[value_start..i].to_string();
            i += 1;
            result.push(Token {
                value,
                start,
                end: i,
                key_start: start,
            });
        } else if bytes[i] == b'{' || bytes[i] == b'}' {
            i += 1;
            result.push(Token {
                value: text[start..i].into(),
                start,
                end: i,
                key_start: start,
            });
        } else {
            return Err("视频配置格式不支持，未修改游戏设置。".into());
        }
    }
    Ok(result)
}

fn fields(text: &str) -> Result<(BTreeMap<String, Token>, usize), String> {
    let mut ts = tokens(text)?;
    if ts.len() < 3
        || ts[0].value != "video.cfg"
        || ts[1].value != "{"
        || ts.last().unwrap().value != "}"
        || (ts.len() - 3) % 2 != 0
    {
        return Err("视频配置格式不支持，未修改游戏设置。".into());
    }
    let close = ts.pop().unwrap().start;
    let mut map = BTreeMap::new();
    let mut pairs = ts.into_iter().skip(2);
    while let Some(key) = pairs.next() {
        let mut value = pairs.next().ok_or("视频配置不完整。")?;
        value.key_start = key.start;
        if key.value == "{"
            || key.value == "}"
            || value.value == "{"
            || value.value == "}"
            || map.insert(key.value, value).is_some()
        {
            return Err("视频配置包含重复或嵌套字段。".into());
        }
    }
    Ok((map, close))
}

pub fn preset(preserve_quality: bool) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    for (key, value) in [
        ("defaultres", DISPLAY_WIDTH),
        ("defaultresheight", DISPLAY_HEIGHT),
        ("aspectratiomode", "1"),
        ("fullscreen", "0"),
        ("coop_fullscreen", "0"),
        ("nowindowborder", "1"),
    ] {
        values.insert(format!("setting.{key}"), value.into());
    }
    if !preserve_quality {
        // CS2's Very High preset, not the numeric maximum of each field.
        for (key, value) in [
            ("shaderquality", "1"),
            ("r_texturefilteringquality", "5"),
            ("msaa_samples", "8"),
            ("r_csgo_cmaa_enable", "0"),
            ("videocfg_shadow_quality", "3"),
            ("videocfg_dynamic_shadows", "1"),
            ("videocfg_texture_detail", "2"),
            ("videocfg_particle_detail", "3"),
            ("videocfg_ao_detail", "3"),
            ("videocfg_hdr_detail", "-1"),
            ("videocfg_fsr_detail", "0"),
        ] {
            values.insert(format!("setting.{key}"), value.into());
        }
    }
    values
}

pub fn apply(text: &str, desired: &BTreeMap<String, String>) -> Result<String, String> {
    let (map, close) = fields(text)?;
    for required in [
        "setting.defaultres",
        "setting.defaultresheight",
        "setting.fullscreen",
    ] {
        if !map.contains_key(required) {
            return Err("视频配置缺少必要字段，请先运行一次 CS2。".into());
        }
    }
    let mut edits = Vec::new();
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut added = String::new();
    for (key, value) in desired {
        if let Some(old) = map.get(key) {
            edits.push((old.start, old.end, format!("\"{value}\"")));
        } else {
            added.push_str(&format!("\t\"{key}\"\t\"{value}\"{newline}"));
        }
    }
    edits.push((close, close, added));
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut output = text.to_string();
    for (start, end, value) in edits {
        output.replace_range(start..end, &value);
    }
    Ok(output)
}

pub fn restore(
    original: &str,
    applied: &str,
    current: &str,
    owned: &BTreeMap<String, String>,
) -> Result<String, String> {
    if current == applied {
        return Ok(original.into());
    }
    let (before, _) = fields(original)?;
    fields(applied)?;
    let (now, _) = fields(current)?;
    let mut edits = Vec::new();
    for key in owned.keys() {
        let Some(value) = now.get(key) else {
            if !before.contains_key(key) {
                continue;
            }
            return Err("游戏视频配置已变更，请保留备份并检查后重试。".into());
        };
        if before.get(key).map(|x| &x.value) == Some(&value.value) {
            continue;
        }
        // These fields belong to the temporary session. The game can persist a
        // new resolution after Host resizing; ending production restores their
        // pre-session values while preserving unrelated fields.
        if let Some(old) = before.get(key) {
            edits.push((value.start, value.end, format!("\"{}\"", old.value)));
        } else {
            edits.push((value.key_start, value.end, String::new()));
        }
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut output = current.to_string();
    for (start, end, value) in edits {
        output.replace_range(start..end, &value);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &str = "\u{feff}\"video.cfg\"\r\n{\r\n// user comment\r\n\"setting.defaultres\" \"1280\"\r\n\"setting.defaultresheight\" \"960\"\r\n\"setting.fullscreen\" \"1\"\r\n\"setting.videocfg_fsr_detail\" \"3\"\r\n\"unrelated\" \"keep\"\r\n}\r\n";
    #[test]
    fn exact_restoration_and_quality_choice() {
        for preserve in [true, false] {
            let preset = preset(preserve);
            let applied = apply(ORIGINAL, &preset).unwrap();
            assert_eq!(fields(&applied).unwrap().0["setting.fullscreen"].value, "0");
            assert_eq!(fields(&applied).unwrap().0["setting.nowindowborder"].value, "1");
            assert!(applied.contains("\"1920\""));
            assert!(applied.contains("// user comment\r\n"));
            assert_eq!(
                fields(&applied).unwrap().0["setting.videocfg_fsr_detail"].value,
                if preserve { "3" } else { "0" }
            );
            assert_eq!(
                restore(ORIGINAL, &applied, &applied, &preset)
                    .unwrap()
                    .as_bytes(),
                ORIGINAL.as_bytes()
            );
        }
    }
    #[test]
    fn preserves_unrelated_edits_and_restores_game_updated_resolution() {
        let preset = preset(false);
        let applied = apply(ORIGINAL, &preset).unwrap();
        let current = applied.replace("\"keep\"", "\"user change\"");
        let restored = restore(ORIGINAL, &applied, &current, &preset).unwrap();
        assert!(restored.contains("\"user change\""));
        assert_eq!(
            fields(&restored).unwrap().0["setting.defaultres"].value,
            "1280"
        );
        assert!(!fields(&restored)
            .unwrap()
            .0
            .contains_key("setting.msaa_samples"));
        let resized = restore(
            ORIGINAL,
            &applied,
            &applied.replace("\"1920\"", "\"1600\""),
            &preset,
        )
        .unwrap();
        assert_eq!(
            fields(&resized).unwrap().0["setting.defaultres"].value,
            "1280"
        );
    }
    #[test]
    fn rejects_unknown_duplicate_truncated_and_missing_config() {
        for text in [
            "garbage",
            "\"video.cfg\" {",
            "\"video.cfg\" { \"x\" \"1\" \"x\" \"2\" }",
            "\"video.cfg\" {}",
        ] {
            assert!(apply(text, &preset(false)).is_err());
        }
    }
    #[test]
    fn removes_added_fields_without_matching_an_unrelated_value() {
        let original = ORIGINAL.replace("\"keep\"", "\"setting.msaa_samples\"");
        let preset = preset(false);
        let applied = apply(&original, &preset).unwrap();
        let changed = applied
            .replace("1280", "1281")
            .replace("// user comment", "// new comment");
        let restored = restore(&original, &applied, &changed, &preset).unwrap();
        assert_eq!(
            fields(&restored).unwrap().0["unrelated"].value,
            "setting.msaa_samples"
        );
        assert!(!fields(&restored)
            .unwrap()
            .0
            .contains_key("setting.msaa_samples"));
    }
}
