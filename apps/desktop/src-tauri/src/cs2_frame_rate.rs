//! Plan bounded startup CFG edits under the existing restoration transaction.
//! Never rewrite Steam launch options or execute commands found in user files.
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

const FILE_LIMIT: usize = 256 * 1024;
const TOTAL_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct Token {
    pub(crate) value: String,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) quoted: bool,
}

pub(crate) fn lex(text: &str, commands: bool) -> Result<Vec<Token>, String> {
    let bytes = text.as_bytes();
    let mut i = if text.starts_with('\u{feff}') { 3 } else { 0 };
    let mut result = Vec::new();
    while i < bytes.len() {
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if commands && (bytes[i] == b'\n' || bytes[i] == b';') {
            result.push(Token {
                value: ";".into(),
                start: i,
                end: i + 1,
                quoted: false,
            });
            i += 1;
        } else if bytes[i].is_ascii_whitespace() {
            i += 1;
        } else if bytes[i] == b'"' {
            let start = i;
            i += 1;
            let content = i;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < bytes.len() && [b'"', b'\\'].contains(&bytes[i + 1])
                {
                    i += 1;
                }
                i += 1;
            }
            if i == bytes.len() {
                return Err("CS2 启动配置的引号不完整。".into());
            }
            let value = text[content..i].replace("\\\"", "\"").replace("\\\\", "\\");
            i += 1;
            result.push(Token {
                value,
                start,
                end: i,
                quoted: true,
            });
        } else if !commands && [b'{', b'}'].contains(&bytes[i]) {
            result.push(Token {
                value: text[i..i + 1].into(),
                start: i,
                end: i + 1,
                quoted: false,
            });
            i += 1;
        } else if commands {
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b';' {
                if bytes[i..].starts_with(b"//") {
                    break;
                }
                i += 1;
            }
            result.push(Token {
                value: text[start..i].into(),
                start,
                end: i,
                quoted: false,
            });
        } else {
            return Err("CS2 或 Steam 配置格式不支持。".into());
        }
    }
    Ok(result)
}

pub(crate) fn field(text: &str, target: &[&str]) -> Result<Option<Token>, String> {
    fn walk(
        tokens: &[Token],
        i: &mut usize,
        path: &mut Vec<String>,
        target: &[&str],
        found: &mut Option<Token>,
        nested: bool,
    ) -> Result<(), String> {
        if path.len() > 32 {
            return Err("启动配置嵌套过深。".into());
        }
        while *i < tokens.len() {
            let key = &tokens[*i];
            if !key.quoted && key.value == "}" {
                if !nested {
                    return Err("启动配置结构无效。".into());
                }
                *i += 1;
                return Ok(());
            }
            if !key.quoted {
                return Err("启动配置字段无效。".into());
            }
            path.push(key.value.clone());
            *i += 1;
            let value = tokens.get(*i).ok_or("启动配置不完整。")?;
            *i += 1;
            if !value.quoted && value.value == "{" {
                walk(tokens, i, path, target, found, true)?;
            } else if value.quoted {
                if path.len() == target.len()
                    && path
                        .iter()
                        .zip(target)
                        .all(|(a, b)| a.eq_ignore_ascii_case(b))
                {
                    if found.replace(value.clone()).is_some() {
                        return Err("启动配置包含重复字段。".into());
                    }
                }
            } else {
                return Err("启动配置值无效。".into());
            }
            path.pop();
        }
        if nested {
            Err("启动配置缺少结束括号。".into())
        } else {
            Ok(())
        }
    }
    let tokens = lex(text, false)?;
    let mut found = None;
    walk(&tokens, &mut 0, &mut Vec::new(), target, &mut found, false)?;
    Ok(found)
}

/// Locate scalar entries of one unambiguous section.
/// Duplicate entries are returned to the caller rather than silently discarded.
pub(crate) fn scalar_section(text: &str, target: &[&str]) -> Result<Vec<(Token, Token)>, String> {
    Ok(scalar_section_with_end(text, target)?.0)
}

/// Return the byte offset of the section's closing brace for safe insertions.
pub(crate) fn scalar_section_with_end(
    text: &str,
    target: &[&str],
) -> Result<(Vec<(Token, Token)>, usize), String> {
    fn walk(
        tokens: &[Token],
        i: &mut usize,
        path: &mut Vec<String>,
        target: &[&str],
        result: &mut Option<(Vec<(Token, Token)>, usize)>,
        nested: bool,
    ) -> Result<(), String> {
        if path.len() > 32 {
            return Err("启动配置嵌套过深。".into());
        }
        let selected = path.len() == target.len()
            && path
                .iter()
                .zip(target)
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
        let mut entries = Vec::new();
        while let Some(key) = tokens.get(*i) {
            if !key.quoted && key.value == "}" {
                if !nested {
                    return Err("启动配置结构无效。".into());
                }
                if selected && result.replace((entries, key.start)).is_some() {
                    return Err("启动配置包含重复配置段。".into());
                }
                *i += 1;
                return Ok(());
            }
            if !key.quoted {
                return Err("启动配置字段无效。".into());
            }
            *i += 1;
            let value = tokens.get(*i).ok_or("启动配置不完整。")?;
            *i += 1;
            if !value.quoted && value.value == "{" {
                if selected {
                    return Err("按键绑定不是可恢复的命令值。".into());
                }
                path.push(key.value.clone());
                walk(tokens, i, path, target, result, true)?;
                path.pop();
            } else if value.quoted {
                if selected {
                    entries.push((key.clone(), value.clone()));
                }
            } else {
                return Err("启动配置值无效。".into());
            }
        }
        if nested {
            Err("启动配置缺少结束括号。".into())
        } else {
            Ok(())
        }
    }
    let tokens = lex(text, false)?;
    let mut result = None;
    walk(&tokens, &mut 0, &mut Vec::new(), target, &mut result, false)?;
    result.ok_or("按键绑定配置段缺失。".into())
}

// Validate the game's scalar without normalizing the saved token. Target choices
// remain integers; original decimal spelling, whitespace and quotes survive.
fn fps_number(value: &str) -> Result<f64, String> {
    let value = value
        .trim()
        .parse::<f64>()
        .map_err(|_| "cs2_machine_convars.vcfg / fps_max：不是有效数值，未修改配置。")?;
    if !value.is_finite() || value < 0.0 || value > f64::from(f32::MAX) {
        return Err("cs2_machine_convars.vcfg / fps_max：数值超出有效范围，未修改配置。".into());
    }
    Ok(value)
}

fn fps_field(text: &str) -> Result<Token, String> {
    let token = field(text, &["config", "convars", "fps_max"])
        .map_err(|error| format!("cs2_machine_convars.vcfg / fps_max：{error}"))?
        .ok_or("缺少 CS2 帧率配置，请先运行一次游戏。")?;
    fps_number(&token.value)?;
    Ok(token)
}
fn patch_convars(text: &str, limit: u16) -> Result<String, String> {
    let token = fps_field(text)?;
    let mut result = text.to_string();
    result.replace_range(token.start..token.end, &format!("\"{limit}\""));
    Ok(result)
}

/// Explicit import restores only fps_max and retains its decimal spelling.
pub fn compatible_restore(backup: &str, current: &str) -> Result<String, String> {
    let before = fps_field(backup)?;
    let entries = scalar_section(current, &["config", "convars"])?;
    let mut edits = Vec::new();
    let mut found = false;
    for (key, value) in entries {
        if key.value.eq_ignore_ascii_case("fps_max") {
            if found {
                edits.push((key.start, value.end, String::new()));
            } else {
                edits.push((value.start, value.end, format!("\"{}\"", before.value)));
                found = true;
            }
        }
    }
    if !found {
        return Err("当前配置缺少 fps_max，请先运行一次 CS2。".into());
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut output = current.to_string();
    for (start, end, value) in edits {
        output.replace_range(start..end, &value);
    }
    Ok(output)
}

struct ConfigScript {
    applied: String,
    includes: Vec<(String, bool)>,
    aliases: BTreeSet<String>,
    commands: BTreeSet<String>,
}
fn patch_script(text: &str, limit: Option<u16>) -> Result<ConfigScript, String> {
    let tokens = lex(text, true)?;
    let mut edits = Vec::new();
    let mut includes = Vec::new();
    let mut aliases = BTreeSet::new();
    let mut commands = BTreeSet::new();
    for command in tokens
        .split(|t| !t.quoted && t.value == ";")
        .filter(|c| !c.is_empty())
    {
        commands.insert(command[0].value.to_ascii_lowercase());
        match command[0].value.to_ascii_lowercase().as_str() {
            "fps_max" => {
                let Some(limit) = limit else {
                    continue;
                };
                if command.len() != 2 || fps_number(&command[1].value).is_err() {
                    return Err("启动配置包含无法可靠修改的 fps_max 命令，请改为直接赋值。".into());
                }
                edits.push((
                    command[1].start,
                    command[1].end,
                    if command[1].quoted {
                        format!("\"{limit}\"")
                    } else {
                        limit.to_string()
                    },
                ));
            }
            "exec" | "execifexists" => {
                if command.len() != 2 {
                    return Err("启动配置包含无法可靠解析的 exec 命令。".into());
                }
                includes.push((
                    command[1].value.clone(),
                    command[0].value.eq_ignore_ascii_case("execifexists"),
                ));
            }
            "exec_async" => {
                return Err(
                    "启动配置使用异步执行，无法保证本次帧率上限，请先移除该启动命令。".into(),
                )
            }
            "alias" => {
                // Definitions and key bindings do not execute their bodies.
                // Refuse startup invocations after scanning all referenced cfgs.
                if let Some(name) = command.get(1) {
                    aliases.insert(name.value.to_ascii_lowercase());
                }
            }
            "incrementvar" | "toggle" => {
                if limit.is_some()
                    && command.iter().skip(1).any(|t| {
                        let value = t.value.to_ascii_lowercase();
                        value.contains("fps_max")
                    })
                {
                    return Err("启动配置包含动态帧率命令，请先改为 fps_max 直接赋值。".into());
                }
            }
            _ => {}
        }
    }
    let mut applied = text.to_string();
    for (start, end, value) in edits.into_iter().rev() {
        applied.replace_range(start..end, &value);
    }
    Ok(ConfigScript {
        applied,
        includes,
        aliases,
        commands,
    })
}

fn read_bounded(path: &Path, limit: usize) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|_| "无法读取 CS2 启动配置。")?;
    if metadata.len() > limit as u64 {
        return Err("CS2 启动配置超过读取上限。".into());
    }
    let value = fs::read_to_string(path).map_err(|_| "CS2 启动配置编码或权限不支持。")?;
    if value.len() > limit {
        return Err("CS2 启动配置超过读取上限。".into());
    }
    Ok(value)
}
fn cfg_root(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|game| game.join("csgo/cfg"))
        .ok_or_else(|| "CS2 程序目录无效。".into())
}
pub(crate) fn included_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(name);
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || name.contains(':')
        || name.is_empty()
    {
        return Err("启动配置只能引用 CS2 cfg 目录内的相对文件。".into());
    }
    let relative = if relative.extension().is_none() {
        relative.with_extension("cfg")
    } else {
        relative.to_path_buf()
    };
    if !relative
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cfg"))
    {
        return Err("启动配置只支持 cfg 文件。".into());
    }
    Ok(root.join(relative))
}
fn canonical_inside(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let path = fs::canonicalize(path).map_err(|_| "找不到引用的 CS2 启动配置。")?;
    let root = fs::canonicalize(root).map_err(|_| "CS2 cfg 目录不可用。")?;
    if !path.starts_with(root) {
        return Err("启动配置链接指向 cfg 目录外，未修改配置。".into());
    }
    Ok(path)
}

/// Prepare every backup before the caller changes any file.
pub fn prepare(video: &Path, executable: &Path, limit: u16) -> Result<Vec<Value>, String> {
    prepare_with_observer(video, executable, limit, false)
}
pub(crate) fn prepare_with_observer(
    video: &Path,
    executable: &Path,
    limit: u16,
    observer: bool,
) -> Result<Vec<Value>, String> {
    if ![0, 30, 60].contains(&limit) {
        return Err("帧率选项无效。".into());
    }
    let directory = video.parent().ok_or("CS2 配置目录不可用。")?;
    let convars = directory.join("cs2_machine_convars.vcfg");
    let original = read_bounded(&convars, FILE_LIMIT)?;
    let applied = patch_convars(&original, limit)?;
    let mut files =
        vec![json!({"kind":"convars", "path":convars, "original":original, "applied":applied})];
    files.extend(prepare_scripts(
        video,
        executable,
        Some(limit),
        observer,
        original.len(),
    )?);
    Ok(files)
}

const OBSERVER_SUFFIX: &str =
    "\n// Mizar session: restore the saved startup file on exit.\nexec mizar_observer.cfg\n";

fn observer_script(text: &str, observer: bool) -> Result<String, String> {
    let result = if observer {
        format!("{text}{OBSERVER_SUFFIX}")
    } else {
        text.to_string()
    };
    if result.len() > FILE_LIMIT {
        return Err("CS2 启动配置超过修改上限。".into());
    }
    Ok(result)
}

/// Standalone spectator mode owns only the final fixed +exec, never FPS values.
pub(crate) fn prepare_observer_scripts(
    video: &Path,
    executable: &Path,
) -> Result<Vec<Value>, String> {
    prepare_scripts(video, executable, None, true, 0)
}

fn prepare_scripts(
    video: &Path,
    executable: &Path,
    limit: Option<u16>,
    observer: bool,
    mut total: usize,
) -> Result<Vec<Value>, String> {
    let directory = video.parent().ok_or("CS2 配置目录不可用。")?;
    let mut files = Vec::new();
    let account = directory
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("Steam 账号目录不可用。")?;
    let localconfig = account.join("config/localconfig.vdf");
    let mut includes = vec![("autoexec.cfg".to_string(), true)];
    let mut aliases = BTreeSet::new();
    let mut commands = BTreeSet::new();
    if localconfig.exists() {
        // Read only. Never put this file, its other fields, or tokens in a journal.
        let local = read_bounded(&localconfig, 16 * 1024 * 1024)?;
        if let Some(options) = field(
            &local,
            &[
                "UserLocalConfigStore",
                "Software",
                "Valve",
                "Steam",
                "Apps",
                "730",
                "LaunchOptions",
            ],
        )? {
            let tokens = lex(&options.value, true)?;
            for (index, token) in tokens.iter().enumerate() {
                if let Some(command) = token.value.strip_prefix('+') {
                    commands.insert(command.to_ascii_lowercase());
                }
                if ["+exec_async", "+alias"]
                    .iter()
                    .any(|name| token.value.eq_ignore_ascii_case(name))
                    || (["+toggle", "+incrementvar"]
                        .iter()
                        .any(|name| token.value.eq_ignore_ascii_case(name))
                        && tokens
                            .get(index + 1)
                            .is_some_and(|t| t.value.eq_ignore_ascii_case("fps_max")))
                {
                    return Err(
                        "Steam 启动项包含动态配置命令，无法保证帧率上限，请先移除该启动项。".into(),
                    );
                }
                if observer
                    && [
                        "+bind",
                        "+binddefaults",
                        "+unbind",
                        "+unbindall",
                        "+spec_usenumberkeys_nobinds",
                    ]
                    .iter()
                    .any(|name| token.value.eq_ignore_ascii_case(name))
                {
                    return Err(
                        "Steam 启动项直接修改观战键位，无法保证本次解说配置，请先移除冲突项。"
                            .into(),
                    );
                }
                if token.value.eq_ignore_ascii_case("+exec")
                    || token.value.eq_ignore_ascii_case("+execifexists")
                {
                    let name = tokens.get(index + 1).ok_or("Steam 启动配置缺少文件名。")?;
                    includes.push((
                        name.value.clone(),
                        token.value.eq_ignore_ascii_case("+execifexists"),
                    ));
                }
                if let Some(limit) = limit.filter(|_| token.value.eq_ignore_ascii_case("+fps_max"))
                {
                    if tokens
                        .get(index + 1)
                        .and_then(|t| fps_number(&t.value).ok())
                        != Some(f64::from(limit))
                    {
                        return Err(
                            "Steam 启动项中的 +fps_max 与本次帧率上限冲突，请先移除该启动项。"
                                .into(),
                        );
                    }
                }
            }
        }
    }
    let root = cfg_root(executable)?;
    let mut visited = BTreeSet::new();
    while let Some((name, optional)) = includes.pop() {
        let path = included_path(&root, &name)?;
        if optional && !path.exists() {
            continue;
        }
        let canonical = canonical_inside(&path, &root)?;
        // Never append an exec of the managed file to itself.
        if observer
            && path.parent() == Some(root.as_path())
            && path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case(crate::cs2_spectator::CFG_NAME))
        {
            continue;
        }
        if !visited.insert(canonical.to_string_lossy().to_lowercase()) {
            continue;
        }
        if visited.len() > 32 {
            return Err("CS2 启动配置引用过多，未修改游戏设置。".into());
        }
        let original = read_bounded(&path, FILE_LIMIT)?;

        total += original.len();
        if total > TOTAL_LIMIT {
            return Err("CS2 启动配置总量超过上限。".into());
        }
        let script = patch_script(&original, limit)?;
        aliases.extend(script.aliases);
        commands.extend(script.commands);
        includes.extend(script.includes);
        let applied = observer_script(&script.applied, observer)?;
        if applied != original {
            files.push(
                json!({"kind":"cfg", "path":path, "original":original, "applied":applied,"observerCfg":observer}),
            );
        }
    }
    if !aliases.is_disjoint(&commands) {
        return Err("启动配置调用了自定义别名，无法保证帧率上限，请改为直接命令后重试。".into());
    }
    Ok(files)
}

pub fn validated<'a>(
    record: &'a Value,
    video: &Path,
    executable: &Path,
    limit: u16,
) -> Result<(&'a Path, &'a str, &'a str), String> {
    validated_script(record, video, executable, Some(limit))
}
pub(crate) fn validated_script<'a>(
    record: &'a Value,
    video: &Path,
    executable: &Path,
    limit: Option<u16>,
) -> Result<(&'a Path, &'a str, &'a str), String> {
    let path = Path::new(record["path"].as_str().ok_or("帧率恢复路径缺失。")?);
    let original = record["original"].as_str().ok_or("原帧率备份缺失。")?;
    let applied = record["applied"].as_str().ok_or("帧率应用记录缺失。")?;
    if original.len() > FILE_LIMIT || applied.len() > FILE_LIMIT || !path.is_absolute() {
        return Err("帧率恢复记录无效。".into());
    }
    let expected = match record["kind"].as_str() {
        Some("convars") => {
            let limit = limit.ok_or("观战启动记录不得修改帧率字段。")?;
            if path
                != video
                    .parent()
                    .ok_or("配置目录缺失。")?
                    .join("cs2_machine_convars.vcfg")
            {
                return Err("帧率恢复路径无效。".into());
            }
            patch_convars(original, limit)?
        }
        Some("cfg") => {
            let root = cfg_root(executable)?;
            if !path.starts_with(&root)
                || path.components().any(|c| matches!(c, Component::ParentDir))
                || !path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("cfg"))
            {
                return Err("启动配置恢复路径无效。".into());
            }
            canonical_inside(path, &root)?;
            let observer = match record.get("observerCfg") {
                None => false,
                Some(Value::Bool(value)) => *value,
                _ => return Err("观战启动记录无效。".into()),
            };
            if limit.is_none() && !observer {
                return Err("观战启动记录缺少固定配置。".into());
            }
            if observer
                && path.parent() == Some(root.as_path())
                && path
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case(crate::cs2_spectator::CFG_NAME))
            {
                return Err("观战启动记录不得修改固定 CFG。".into());
            }
            observer_script(&patch_script(original, limit)?.applied, observer)?
        }
        _ => return Err("帧率恢复类型无效。".into()),
    };
    if expected != applied {
        return Err("帧率备份与应用记录不一致。".into());
    }
    Ok((path, original, applied))
}

pub fn restored(record: &Value, current: &str) -> Result<String, String> {
    let original = record["original"].as_str().ok_or("原帧率备份缺失。")?;
    let applied = record["applied"].as_str().ok_or("帧率应用记录缺失。")?;
    if current == applied || current == original {
        return Ok(original.to_string());
    }
    if record["kind"] == "convars" {
        let before = fps_field(original)?;
        let now = fps_field(current)?;
        let mut result = current.to_string();
        result.replace_range(now.start..now.end, &original[before.start..before.end]);
        Ok(result)
    } else {
        Err("本次启动配置已被外部修改，请检查帧率备份后重试恢复。".into())
    }
}
