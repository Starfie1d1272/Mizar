//! Lossless edits of the flat video.cfg object. Unknown fields and comments survive.
use crate::cs2_preferences::Quality;
use std::collections::BTreeMap;

pub const DISPLAY_WIDTH: &str = "1920";
pub const DISPLAY_HEIGHT: &str = "1080";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoSize {
    pub width: i32,
    pub height: i32,
}
impl VideoSize {
    pub fn new(width: i32, height: i32) -> Result<Self, String> {
        if width <= 0 || height <= 0 || i64::from(width) * 9 != i64::from(height) * 16 {
            return Err("工作台游戏尺寸无效，未修改游戏配置。".into());
        }
        Ok(Self { width, height })
    }
}

#[derive(Debug)]
struct Token {
    value: String,
    start: usize,
    end: usize,
    key_start: usize,
    quoted: bool,
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
                quoted: true,
            });
        } else if bytes[i] == b'{' || bytes[i] == b'}' {
            i += 1;
            result.push(Token {
                value: text[start..i].into(),
                start,
                end: i,
                key_start: start,
                quoted: false,
            });
        } else {
            return Err("视频配置格式不支持，未修改游戏设置。".into());
        }
    }
    Ok(result)
}

fn fields(text: &str) -> Result<(BTreeMap<String, Token>, usize), String> {
    let mut ts = tokens(text)?;
    if ts
        .iter()
        .skip(2)
        .take(ts.len().saturating_sub(3))
        .any(|t| !t.quoted && (t.value == "{" || t.value == "}"))
    {
        return Err("cs2_video.txt：包含嵌套字段，未修改配置；可保持原游戏设置继续。".into());
    }
    if ts.len() < 3
        || !ts[0].quoted
        || ts[0].value != "video.cfg"
        || ts[1].quoted
        || ts[1].value != "{"
        || ts.last().unwrap().quoted
        || ts.last().unwrap().value != "}"
        || (ts.len() - 3) % 2 != 0
    {
        return Err("视频配置格式不支持，未修改游戏设置。".into());
    }
    let close = ts.pop().unwrap().start;
    let mut map = BTreeMap::new();
    let mut duplicate = None;
    let mut pairs = ts.into_iter().skip(2);
    while let Some(key) = pairs.next() {
        let mut value = pairs.next().ok_or("视频配置不完整。")?;
        value.key_start = key.start;
        if !key.quoted || !value.quoted {
            return Err("cs2_video.txt：包含嵌套字段，未修改配置；可保持原游戏设置继续。".into());
        }
        if let Some(previous) = map.get(&key.value) {
            let previous: &Token = previous;
            // Only known field names are exposed. Never include user values.
            let name = if quality_preset(Quality::VeryHigh).contains_key(&key.value) {
                key.value.as_str()
            } else {
                "其他字段"
            };
            let kind = if previous.value == value.value {
                "同值重复"
            } else {
                "冲突重复"
            };
            if duplicate.is_none() || kind == "冲突重复" {
                duplicate = Some(format!(
                    "cs2_video.txt / {name}：{kind}，未修改配置；请检查备份，或保持原游戏设置继续。"
                ));
            }
            continue;
        }
        map.insert(key.value, value);
    }
    if let Some(error) = duplicate {
        return Err(error);
    }
    Ok((map, close))
}

pub fn quality_preset(quality: Quality) -> BTreeMap<String, String> {
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
    if quality != Quality::Preserve {
        // CS2's native presets; numeric field maxima are not quality presets.
        let (shader, filtering, msaa, shadow, texture, particle, ao, hdr, fsr) = match quality {
            Quality::VeryHigh => ("1", "5", "8", "3", "2", "3", "3", "-1", "0"),
            Quality::High => ("1", "3", "4", "2", "2", "2", "2", "-1", "0"),
            Quality::Medium => ("0", "1", "2", "1", "1", "1", "0", "3", "2"),
            Quality::Preserve => unreachable!(),
        };
        for (key, value) in [
            ("shaderquality", shader),
            ("r_texturefilteringquality", filtering),
            ("msaa_samples", msaa),
            ("r_csgo_cmaa_enable", "0"),
            ("videocfg_shadow_quality", shadow),
            ("videocfg_dynamic_shadows", "1"),
            ("videocfg_texture_detail", texture),
            ("videocfg_particle_detail", particle),
            ("videocfg_ao_detail", ao),
            ("videocfg_hdr_detail", hdr),
            ("videocfg_fsr_detail", fsr),
        ] {
            values.insert(format!("setting.{key}"), value.into());
        }
    }
    values
}

pub fn sized_quality_preset(quality: Quality, size: VideoSize) -> BTreeMap<String, String> {
    let mut values = quality_preset(quality);
    values.insert("setting.defaultres".into(), size.width.to_string());
    values.insert("setting.defaultresheight".into(), size.height.to_string());
    values
}

pub fn supported_preset(values: &BTreeMap<String, String>) -> bool {
    let size = (|| {
        VideoSize::new(
            values.get("setting.defaultres")?.parse().ok()?,
            values.get("setting.defaultresheight")?.parse().ok()?,
        )
        .ok()
    })();
    size.is_some_and(|size| {
        [
            Quality::VeryHigh,
            Quality::High,
            Quality::Medium,
            Quality::Preserve,
        ]
        .into_iter()
        .any(|quality| *values == sized_quality_preset(quality, size))
    })
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

/// Explicit backup import owns only recognized video settings. Preserve every
/// unrelated token, including comments; resolve duplicate owned keys from the
/// selected, unambiguous backup rather than choosing a current duplicate.
pub fn compatible_restore(backup: &str, current: &str) -> Result<String, String> {
    let (before, _) = fields(backup)?;
    let known = quality_preset(Quality::VeryHigh);
    let desired: BTreeMap<_, _> = before.iter().filter(|(key, _)| known.contains_key(*key))
        .map(|(key, value)| (key.clone(), value.value.clone())).collect();
    for key in ["setting.defaultres", "setting.defaultresheight", "setting.fullscreen"] {
        if !desired.contains_key(key) { return Err("备份缺少必要画面设置，请选择完整的视频配置备份。".into()); }
    }
    for (key, value) in &desired {
        let number: i32 = value.parse().map_err(|_| "备份中的画面设置不是有效数值。")?;
        if number < -1 || number > 32768 || (key.starts_with("setting.defaultres") && number <= 0) {
            return Err("备份中的画面设置超出有效范围。".into());
        }
    }
    let ts = tokens(current)?;
    if ts.len() < 3 || ts[0].value != "video.cfg" || !ts[0].quoted || ts[1].quoted || ts[1].value != "{"
        || ts.last().unwrap().quoted || ts.last().unwrap().value != "}" || (ts.len()-3)%2 != 0 {
        return Err("当前视频配置结构无法识别，请保留原件后检查。".into());
    }
    let mut edits = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for pair in ts[2..ts.len()-1].chunks_exact(2) {
        let (key, value) = (&pair[0], &pair[1]);
        if !key.quoted || !value.quoted { return Err("当前视频配置包含嵌套结构，请先检查原件。".into()); }
        if let Some(replacement) = desired.get(&key.value) {
            if seen.insert(key.value.clone()) { edits.push((value.start, value.end, format!("\"{replacement}\""))); }
            else { edits.push((key.start, value.end, String::new())); }
        }
    }
    let newline = if current.contains("\r\n") { "\r\n" } else { "\n" };
    let mut added = String::new();
    for (key, value) in desired { if !seen.contains(&key) { added.push_str(&format!("\t\"{key}\"\t\"{value}\"{newline}")); } }
    let close = ts.last().unwrap().start;
    edits.push((close, close, added));
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut output = current.to_string();
    for (start, end, value) in edits { output.replace_range(start..end, &value); }
    Ok(output)
}
