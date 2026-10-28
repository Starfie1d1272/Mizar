//! Process-scoped HUD value journal; game settings are restored through the existing MulNX queue.
use crate::{cs2_console, managed_cs2, startup_log::DesktopLog};
use std::{fs, io::{Read, Write, Seek, SeekFrom}, path::Path, process::Command, os::windows::process::CommandExt, sync::Mutex, time::{Duration, Instant}};
use serde_json::{Value, json};
static JOURNAL: Mutex<()> = Mutex::new(());

fn file(log: &DesktopLog) -> std::path::PathBuf { log.state_root.join("data/observer-hud.json") }
fn load(log: &DesktopLog) -> Result<Option<Value>, String> {
    let path = file(log);
    match fs::read(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(log.preserve_error("observer_hud", None, &error, "请检查观战 HUD 恢复记录。".to_string())),
        Ok(bytes) if bytes.len() <= 4096 => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if value["version"] != 1 || ![Some(0), Some(1)].contains(&value["original"].as_u64())
                || !value["pid"].as_u64().is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64)
                || !value["created"].as_u64().is_some_and(|created| created > 0)
                || value["executable"].as_str().is_none() {
                return Err("请检查观战 HUD 恢复记录中的原值。".into());
            }
            Ok(Some(value))
        },
        _ => Err("请检查观战 HUD 恢复记录的大小。".into()),
    }
}

pub fn parse_value(text: &str, marker: &str) -> Result<u8, String> {
    // The marker must be output by echo, not merely present in a logged command.
    let marker_line = regex::Regex::new(&format!(r"(?m)^(?:\[[^\]\r\n]{{1,80}}\]\s*)*{}\r?$", regex::escape(marker))).unwrap();
    let start = marker_line.find_iter(text).last().ok_or("等待游戏返回本次 HUD 查询。")?.end();
    let expression = regex::Regex::new(r#"(?i)\bcl_draw_only_deathnotices\b"?\s*(?:=|:)?\s*"?(true|false|[01])\b"#).unwrap();
    let values: Vec<u8> = expression.captures_iter(&text[start..]).map(|capture| {
        if capture[1].eq_ignore_ascii_case("true") || &capture[1] == "1" { 1 } else { 0 }
    }).collect();
    let value = *values.first().ok_or("等待游戏返回 HUD 当前值。")?;
    if values.iter().any(|candidate| *candidate != value) { return Err("HUD 查询结果发生变化，请重试。".into()); }
    Ok(value)
}

fn query(log: &DesktopLog, executable: &Path, value: Option<u8>) -> Result<u8, String> {
    let marker = format!("MIZAR_HUD_{:032x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos());
    let root = crate::bundle_root()?;
    let mut command = Command::new(root.join("resources/runtime/node.exe"));
    command.arg(root.join("resources/app/dist/telemetry/observer-game-control.js")).args(["--observer-query", &marker])
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").creation_flags(0x08000000);
    if let Some(value) = value { command.arg(value.to_string()); }
    crate::powershell::run(command, log, "观战 HUD 查询", Duration::from_secs(12))?;
    let path = cs2_console::path(executable)?;
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if let Ok(mut reader) = fs::File::open(&path) {
            let length = reader.metadata().map_err(|e| e.to_string())?.len();
            reader.seek(SeekFrom::Start(length.saturating_sub(65536))).map_err(|e| e.to_string())?;
            let mut bytes = Vec::new(); reader.take(65536).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if let Ok(found) = parse_value(&String::from_utf8_lossy(&bytes), &marker) { return Ok(found); }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("请确认当前 CS2 使用本机控制台记录并已连接 MulNX；HUD 原值读回尚待确认。".into())
}

/// Validate consent before launching; restoration reads only this transaction's bounded reply,
/// even if continuous diagnostics were subsequently disabled.
pub fn preflight(log: &DesktopLog, use_mulnx: bool) -> Result<bool, String> {
    if !use_mulnx { return Ok(false); }
    let (code, value) = crate::production_exit::request_with_identity(log, "GET", "/local/v1/observer-assist", "",
        Instant::now() + Duration::from_secs(5), None)?;
    if code != 200 { return Err("无法核对自动隐藏 HUD 设置，请检查本地服务后重试。".into()); }
    validate_preflight(log, &value)
}

fn validate_preflight(log: &DesktopLog, value: &Value) -> Result<bool, String> {
    if !value["gameAutomation"]["hideGameHud"].is_boolean() {
        return Err("无法核对自动隐藏 HUD 设置，请检查本地服务后重试。".into());
    }
    let hide = value["gameAutomation"]["hideGameHud"] == true;
    let recovery = load(log)?.map(|record| managed_cs2::verified_session_process(&record, log))
        .transpose()?.flatten().is_some();
    if hide && !recovery && cs2_console::settings(log)?["enabled"] != true {
        return Err("自动隐藏 HUD 需要核对游戏当前值。请在高级设置开启本机控制台记录后重新启动游戏，或关闭自动隐藏选项。".into());
    }
    Ok(hide)
}

pub fn snapshot(log: &DesktopLog, executable: &Path, process: &managed_cs2::WorkspaceProcess) -> Result<u8, String> {
    let _guard = JOURNAL.lock().map_err(|_| "HUD 恢复记录正忙。")?;
    if let Some(previous) = load(log)? {
        if managed_cs2::verified_session_process(&previous, log)?.is_some() {
            if previous["pid"] == process.pid && previous["created"] == process.created {
                return Ok(previous["original"].as_u64().unwrap() as u8);
            }
            return Err("请先恢复此前游戏实例的 HUD 设置。".into());
        }
        fs::remove_file(file(log)).map_err(|e| e.to_string())?;
    }
    let original = query(log, executable, None)?;
    let record = json!({"version":1,"pid":process.pid,"created":process.created,"executable":executable,"original":original});
    fs::create_dir_all(log.state_root.join("data")).map_err(|e| e.to_string())?;
    let temporary = file(log).with_extension(format!("{}.tmp", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos()));
    let mut writer = fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e| e.to_string())?;
    writer.write_all(record.to_string().as_bytes()).map_err(|e| e.to_string())?;
    writer.sync_all().map_err(|e| e.to_string())?;
    drop(writer);
    fs::rename(temporary, file(log)).map_err(|e| e.to_string())?;
    Ok(original)
}

pub fn pending(log: &DesktopLog) -> bool { file(log).exists() && !crate::observer_workspace::active() }

pub fn restore(log: &DesktopLog) -> Result<(), String> {
    let _guard = JOURNAL.lock().map_err(|_| "HUD 恢复记录正忙。")?;
    let Some(record) = load(log)? else { return Ok(()); };
    if managed_cs2::verified_session_process(&record, log)?.is_some() {
        let original = record["original"].as_u64().unwrap() as u8;
        let executable = Path::new(record["executable"].as_str().ok_or("HUD 恢复程序路径缺失。")?);
        if query(log, executable, Some(original))? != original { return Err("请重试恢复观战 HUD 原值。".into()); }
    }
    fs::remove_file(file(log)).map_err(|e| e.to_string())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test]
    fn fresh_install_blocks_hud_automation_until_its_independent_dependency_is_ready() {
        let root = std::env::temp_dir().join(format!("mizar-hud-preflight-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let log = DesktopLog::new(&root, None).unwrap();
        let default_game = json!({"gameAutomation":{"hideGameHud":true}});
        let initial = cs2_console::settings(&log).unwrap();
        assert_eq!(initial["enabled"], true);
        cs2_console::set_enabled(&log, false, initial["generation"].as_str()).unwrap();
        assert!(validate_preflight(&log, &default_game).unwrap_err().contains("开启本机控制台记录"));
        assert!(!file(&log).exists()); // No game/HUD transaction is created by refusal.
        assert!(!validate_preflight(&log, &json!({"gameAutomation":{"hideGameHud":false}})).unwrap());
        let current = cs2_console::settings(&log).unwrap();
        cs2_console::set_enabled(&log, true, current["generation"].as_str()).unwrap();
        assert!(validate_preflight(&log, &default_game).unwrap());
        assert!(validate_preflight(&log, &json!({})).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test] fn reads_only_the_current_marker_and_current_value() {
        assert_eq!(parse_value("old cl_draw_only_deathnotices 1\nMARK\n\"cl_draw_only_deathnotices\" = \"0\" (def. 1)", "MARK").unwrap(), 0);
        assert_eq!(parse_value("[Console] MARK\ncl_draw_only_deathnotices = true", "MARK").unwrap(), 1);
        assert!(parse_value("echo MARK;cl_draw_only_deathnotices 0;cl_draw_only_deathnotices", "MARK").is_err());
        assert!(parse_value("cl_draw_only_deathnotices 0", "MARK").is_err());
        assert!(parse_value("MARK\ncl_draw_only_deathnotices 0\ncl_draw_only_deathnotices 1", "MARK").is_err());
    }
}
