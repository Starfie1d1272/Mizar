//! Optional technical console evidence. Never exports the game's raw console file.
use crate::startup_log::DesktopLog;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const SETTINGS: &str = "console-settings.json";
const CURSOR: &str = "console-cursor.json";
pub const READ_BYTES: usize = 256 * 1024;
const LINE_BYTES: usize = 16 * 1024;
const STATE_BYTES: usize = 8192;
fn utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn failure(error: impl std::fmt::Debug) -> String {
    format!("CS2 技术日志不可读取：{error:?}")
}
fn plain(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}
fn parents(path: &Path) -> io::Result<()> {
    for ancestor in path
        .parent()
        .ok_or_else(|| io::Error::other("console parent missing"))?
        .ancestors()
    {
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || !plain(&metadata) {
            return Err(io::Error::other("console parent is not plain"));
        }
    }
    Ok(())
}
#[cfg(windows)]
fn identity(file: &File) -> io::Result<String> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct Time {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        creation: Time,
        access: Time,
        write: Time,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(file: *mut c_void, information: *mut Information) -> i32;
    }
    let mut value = Information::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if value.links != 1 || value.attributes & 0x400 != 0 {
        return Err(io::Error::other("console source is linked or reparsed"));
    }
    Ok(format!(
        "windows:{:x}:{:x}:{:x}",
        value.volume, value.index_high, value.index_low
    ))
}
#[cfg(not(windows))]
fn identity(file: &File) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if metadata.nlink() != 1 {
        return Err(io::Error::other("console source is hard-linked"));
    }
    Ok(format!("unix:{:x}:{:x}", metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn verify_handle_path(file: &File, path: &Path) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let mut value = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            value.as_mut_ptr(),
            value.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= value.len() {
        return Err(io::Error::other("console final path exceeds budget"));
    }
    let actual = String::from_utf16(&value[..length as usize]).map_err(io::Error::other)?;
    let expected = std::path::absolute(path)?;
    let expected = expected
        .to_str()
        .ok_or_else(|| io::Error::other("console path encoding invalid"))?;
    let normalize = |value: &str| {
        value
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase()
    };
    if normalize(&actual) != normalize(expected) {
        return Err(io::Error::other("console handle escaped fixed path"));
    }
    Ok(())
}
fn checked(path: &Path) -> io::Result<(File, String)> {
    parents(path)?;
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || !plain(&before) {
        return Err(io::Error::other("console source is not a plain file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    let file_id = identity(&file)?;
    #[cfg(windows)]
    verify_handle_path(&file, path)?;
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt;
        let actual = file.metadata()?;
        if actual.ino() != before.ino() || actual.dev() != before.dev() {
            return Err(io::Error::other("console source changed before open"));
        }
    }
    let named = File::open(path)?;
    if identity(&named)? != file_id || !plain(&file.metadata()?) {
        return Err(io::Error::other("console source identity changed"));
    }
    Ok((file, file_id))
}
fn state_directory(log: &DesktopLog) -> PathBuf {
    log.state_root.join("diagnostics")
}
fn read_state(path: &Path) -> Result<Option<Value>, String> {
    let (mut file, _) = match checked(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error)),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take(STATE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > STATE_BYTES {
        return Err("CS2 技术日志状态超过预算。".into());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(failure)
}
static SETTINGS_WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
static DISABLED_ROOTS: std::sync::Mutex<std::collections::BTreeMap<PathBuf, String>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());
fn disabled_marker(log: &DesktopLog) -> PathBuf {
    log.state_root.join("console-capture-disabled.flag")
}
fn generation() -> String {
    digest(format!(
        "{:?}:{}",
        std::time::SystemTime::now(),
        std::process::id()
    ))
}
fn marker_generation(log: &DesktopLog) -> Result<Option<String>, String> {
    let (mut file, _) = match checked(&disabled_marker(log)) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(error)),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take(65)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() != 64 || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return Err("技术日志关闭标记无法核实，读取保持关闭。".into());
    }
    String::from_utf8(bytes).map(Some).map_err(failure)
}
pub fn settings(log: &DesktopLog) -> Result<Value, String> {
    let memory_fence = DISABLED_ROOTS
        .lock()
        .map_err(failure)?
        .get(&log.state_root)
        .cloned();
    let disk_fence = marker_generation(log)?;
    let fence = memory_fence.clone().or_else(|| disk_fence.clone());
    let loaded = read_state(&state_directory(log).join(SETTINGS));
    let mut value = match loaded {
        Ok(Some(value)) => value,
        Ok(None) => json!({"enabled":false,"generation":null}),
        Err(error) if fence.is_some() => json!({"enabled":false,"generation":null,"warning":error}),
        Err(error) => return Err(error),
    };
    if value["generation"].is_null() && value["enabled"] == false { /* Default off needs no enable document. */
    } else if value["version"] != 1
        || !value["enabled"].is_boolean()
        || value["generation"].as_str().is_none_or(|value| {
            value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        if fence.is_none() {
            return Err("CS2 技术日志设置无法核实，读取保持关闭。".into());
        }
        value = json!({"enabled":false,"warning":"console_settings_invalid_while_disabled"});
    }
    let pending = memory_fence.is_some() && disk_fence.is_none() && value["enabled"] == true;
    if let Some(fence) = fence {
        value["enabled"] = json!(false);
        value["generation"] = json!(fence);
    }
    value["revocationPending"] = json!(pending);
    Ok(value)
}
pub fn set_enabled(
    log: &DesktopLog,
    enabled: bool,
    expected_generation: Option<&str>,
) -> Result<Value, String> {
    let _guard = SETTINGS_WRITER.lock().map_err(failure)?;
    if !enabled {
        // A separate durable fence wins over an old enable document and over
        // stale in-flight enable requests. No game file is changed or removed.
        let epoch = generation();
        DISABLED_ROOTS
            .lock()
            .map_err(failure)?
            .insert(log.state_root.clone(), epoch.clone());
        let marker = disabled_marker(log);
        let persist = (|| {
            parents(&marker).map_err(failure)?;
            match checked(&marker) {
                Ok(_) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(failure(error)),
            }
            crate::cs2_session::atomic_write(&marker, epoch.as_bytes())
        })();
        if let Err(error) = persist {
            let removed = fs::remove_file(state_directory(log).join(SETTINGS));
            return Err(format!(
                "技术日志关闭未能完整保存：{error}; consentRemoval={removed:?}"
            ));
        }
        return settings(log);
    }
    let current = settings(log)?;
    if current["enabled"] == true {
        return Ok(current);
    }
    if current["generation"].as_str() != expected_generation {
        return Err("技术日志设置已变化，请重新读取后确认。".into());
    }
    let directory = state_directory(log);
    fs::create_dir_all(&directory).map_err(failure)?;
    parents(&directory.join(SETTINGS)).map_err(failure)?;
    let value = json!({"version":1,"enabled":true,"generation":generation(),"changedAt":utc()});
    crate::cs2_session::atomic_write(
        &directory.join(SETTINGS),
        &serde_json::to_vec(&value).map_err(failure)?,
    )?;
    if marker_generation(log)?.is_some() {
        fs::remove_file(disabled_marker(log)).map_err(failure)?;
    }
    DISABLED_ROOTS
        .lock()
        .map_err(failure)?
        .remove(&log.state_root);
    Ok(value)
}
pub fn path(executable: &Path) -> Result<PathBuf, String> {
    for (level, expected) in ["win64", "bin", "game"].iter().enumerate() {
        if !executable
            .ancestors()
            .nth(level + 1)
            .and_then(Path::file_name)
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(expected))
        {
            return Err("CS2 技术日志目录布局无法核实。".into());
        }
    }

    if !executable
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("cs2.exe"))
    {
        return Err("CS2 技术日志来源程序无效。".into());
    }
    executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|game| game.join("csgo/console.log"))
        .ok_or_else(|| "CS2 技术日志目录无法核实。".into())
}
fn encoding(file: &mut File) -> io::Result<&'static str> {
    file.seek(SeekFrom::Start(0))?;
    let mut bom = [0; 3];
    let count = file.read(&mut bom)?;
    Ok(if count >= 2 && bom[..2] == [0xff, 0xfe] {
        "utf16le"
    } else if count >= 2 && bom[..2] == [0xfe, 0xff] {
        "utf16be"
    } else {
        "utf8"
    })
}
fn anchor(file: &mut File, offset: u64) -> io::Result<String> {
    let size = offset.min(128) as usize;
    file.seek(SeekFrom::Start(offset - size as u64))?;
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes)?;
    Ok(digest(bytes))
}
/// Called before the Steam request, after discovery. No pre-session text is copied.
pub fn prepare(log: &DesktopLog, executable: &Path) -> Result<Option<Value>, String> {
    let config = settings(log)?;
    if config["enabled"] != true {
        return Ok(None);
    }
    let after = utc();
    let (id, offset, encoding, anchor) = match checked(&path(executable)?) {
        Ok((mut file, id)) => {
            let offset = file.metadata().map_err(failure)?.len();
            (
                Some(id),
                offset,
                encoding(&mut file).map_err(failure)?.to_string(),
                anchor(&mut file, offset).map_err(failure)?,
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            (None, 0, "utf8".into(), digest([]))
        }
        Err(error) => return Err(failure(error)),
    };
    Ok(Some(
        json!({"version":1,"generation":config["generation"],"identity":id,"offset":offset,"encoding":encoding,"anchor":anchor,"sourceAfterUtc":after}),
    ))
}

/// The caller must prove the actual PID, creation time and executable before constructing.
pub struct Capture {
    path: PathBuf,
    binding: String,
    generation: String,
    cursor: Value,
}
impl Capture {
    pub fn new(log: &DesktopLog, journal: &Value) -> Result<Self, String> {
        let executable = PathBuf::from(journal["executable"].as_str().ok_or("CS2 日志来源缺失。")?);
        let config = settings(log)?;
        if config["enabled"] != true {
            return Err("CS2 技术日志读取已关闭。".into());
        }
        if journal["consoleDiagnostics"]["version"] != 1 {
            return Err("本次游戏未开启技术日志，下次由 Mizar 启动后生效。".into());
        }
        let generation = config["generation"]
            .as_str()
            .ok_or("CS2 技术日志同意编号缺失。")?
            .to_string();
        let binding = digest(format!(
            "{}:{}:{}:{}",
            executable.display(),
            journal["launchTime"],
            journal["pid"],
            journal["created"]
        ));
        let initial = if journal["consoleDiagnostics"]["generation"] == config["generation"] {
            journal["consoleDiagnostics"].clone()
        } else {
            prepare(log, &executable)?.ok_or("CS2 技术日志读取已关闭。")?
        };
        let mut cursor = json!({"version":1,"binding":binding,"generation":generation,"identity":initial["identity"],"offset":initial["offset"],"encoding":initial["encoding"],"anchor":initial["anchor"],"sourceAfterUtc":initial["sourceAfterUtc"],"discarding":false,"observations":[],"technical":0,"unknown":0,"chat":0,"invalid":0,"gaps":0});
        if let Some(saved) = read_state(&state_directory(log).join(CURSOR))? {
            if saved["version"] == 1
                && saved["binding"] == binding
                && saved["generation"] == generation
                && valid_cursor(&saved)
            {
                cursor = saved;
            }
        }
        if !valid_cursor(&cursor) {
            return Err("CS2 技术日志边界无法核实。".into());
        }
        Ok(Self {
            path: path(&executable)?,
            binding,
            generation,
            cursor,
        })
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn binding(journal: &Value) -> String {
        digest(format!(
            "{}:{}:{}:{}",
            journal["executable"].as_str().unwrap_or_default(),
            journal["launchTime"],
            journal["pid"],
            journal["created"]
        ))
    }
    pub fn health(&self) -> Value {
        json!({"phase":"reading","binding":self.binding,"offset":self.cursor["offset"],"technical":self.cursor["technical"],"unknown":self.cursor["unknown"],"chat":self.cursor["chat"],"invalid":self.cursor["invalid"],"gaps":self.cursor["gaps"],"backlogBytes":self.cursor["backlogBytes"],"scope":"recognized technical console lines only; unknown/chat/raw file excluded","limits":{"readBytes":READ_BYTES,"serializedEvidenceBytes":128*1024,"technicalLines":256,"sourceLineBytes":LINE_BYTES},"rawEngineFileBudgetOwnedBy":"game; Mizar never truncates or deletes it","recognizedTechnicalOutputObserved":self.cursor["technical"].as_u64().unwrap_or(0)>0,"launchFlag":"requested; engine acceptance not independently confirmed"})
    }
    fn active(&self, log: &DesktopLog) -> Result<(), String> {
        let value = settings(log)?;
        if value["enabled"] != true || value["generation"] != self.generation {
            return Err("console_capture_interrupted: consent_changed".into());
        }
        Ok(())
    }
    pub fn poll(&mut self, log: &DesktopLog, owned: &impl Fn() -> bool) -> Result<Value, String> {
        let previous = self.cursor.clone();
        let result = self.collect(log, owned);
        if result.is_err() {
            self.cursor = previous;
        }
        result
    }
    fn flush(
        &self,
        log: &DesktopLog,
        records: &mut Vec<Value>,
        owned: &impl Fn() -> bool,
    ) -> Result<(), String> {
        if !owned() {
            return Err("console_capture_interrupted: process_not_owned_before_commit".into());
        }
        if records.is_empty() {
            return Ok(());
        }
        self.active(log)?;
        let detail = json!({"binding":self.binding,"records":records,"source":"owned-cs2-technical-console","rawFileIncluded":false}).to_string();
        // Kept below DesktopLog's fragment threshold so each source-time decision
        // stays independently interpretable before any cloud copy is made.
        if detail.len() > 7500 {
            return Err("CS2 技术日志持久分段超过预算。".into());
        }
        log.committed_event("cs2_console_records", "observed", Some(&detail))
            .map_err(failure)?;
        records.clear();
        Ok(())
    }
    fn collect(&mut self, log: &DesktopLog, owned: &impl Fn() -> bool) -> Result<Value, String> {
        if !owned() {
            return Err("console_capture_interrupted: process_not_owned_before_read".into());
        }
        self.active(log)?;
        let (mut file, id) = match checked(&self.path) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(
                    json!({"phase":if self.cursor["identity"].is_null() {"source_not_created"} else {"source_missing"},"binding":self.binding,"scope":"-condebug requested; engine output not verified; removed unread bytes may be unavailable"}),
                )
            }
            Err(error) => return Err(failure(error)),
        };
        let observed_at = utc();
        let length = file.metadata().map_err(failure)?.len();
        let mut offset = self.cursor["offset"]
            .as_u64()
            .ok_or("CS2 技术日志游标无效。")?;
        let old_backlog = self.cursor["backlogBytes"].clone();
        let old_invalid = self.cursor["invalid"].clone();
        let first_file = self.cursor["identity"].is_null();
        let changed = !first_file && self.cursor["identity"] != id;
        let rewritten = !changed
            && (offset > length
                || (!first_file
                    && anchor(&mut file, offset).map_err(failure)? != self.cursor["anchor"]));
        if changed || rewritten {
            offset = 0;
            self.cursor["offset"] = json!(0);
            self.cursor["sourceAfterUtc"] = Value::Null;
            self.cursor["observations"] = json!([]);
            self.cursor["discarding"] = json!(false);
            increment(&mut self.cursor, "gaps");
        }
        if first_file || changed || rewritten {
            self.cursor["identity"] = json!(id);
            self.cursor["encoding"] = json!(encoding(&mut file).map_err(failure)?);
        }
        let observations = self.cursor["observations"]
            .as_array_mut()
            .ok_or("CS2 技术日志时间边界缺失。")?;
        if observations
            .last()
            .is_none_or(|value| value["offset"] != length)
        {
            observations.push(json!({"offset":length,"after":observed_at}));
            if observations.len() > 16 {
                observations.remove(0);
            }
        } else if let Some(last) = observations.last_mut() {
            last["after"] = json!(observed_at);
        }
        let mode = self.cursor["encoding"]
            .as_str()
            .ok_or("CS2 技术日志编码缺失。")?
            .to_owned();
        file.seek(SeekFrom::Start(offset)).map_err(failure)?;
        let mut bytes = vec![0; (length - offset).min(READ_BYTES as u64) as usize];
        let count = file.read(&mut bytes).map_err(failure)?;
        bytes.truncate(count);
        let captured_at = utc();
        let mut start = 0;
        let mut records = Vec::new();
        let mut record_bytes = 0;
        let mut total_record_bytes = 0;
        let mut technical_lines = 0;
        while start < bytes.len() {
            let next = newline(&bytes[start..], &mode);
            let Some((end, width)) = next else {
                if bytes.len() - start > LINE_BYTES || self.cursor["discarding"] == true {
                    self.cursor["discarding"] = json!(true);
                    let consumed = if mode == "utf8" {
                        bytes.len()
                    } else {
                        bytes.len() - bytes.len() % 2
                    };
                    self.cursor["offset"] = json!(offset + consumed as u64);
                    increment(&mut self.cursor, "invalid");
                }
                break;
            };
            let raw = &bytes[start..start + end];
            let source_offset = offset + start as u64;
            start += end + width;
            self.cursor["offset"] = json!(offset + start as u64);
            if self.cursor["discarding"] == true {
                self.cursor["discarding"] = json!(false);
                continue;
            }
            if raw.len() > LINE_BYTES {
                increment(&mut self.cursor, "invalid");
                continue;
            }
            let Ok(line) = decode(raw, &mode) else {
                increment(&mut self.cursor, "invalid");
                continue;
            };
            let line = line.trim_start_matches('\u{feff}').trim_end_matches('\r');
            let channel = match category(line) {
                Category::Chat => {
                    increment(&mut self.cursor, "chat");
                    continue;
                }
                Category::Unknown => {
                    increment(&mut self.cursor, "unknown");
                    continue;
                }
                Category::Technical(channel) => channel,
            };
            let after = self.cursor["observations"]
                .as_array()
                .and_then(|values| {
                    values.iter().rev().find(|value| {
                        value["offset"]
                            .as_u64()
                            .is_some_and(|offset| offset <= source_offset)
                    })
                })
                .map(|value| value["after"].clone())
                .unwrap_or_else(|| self.cursor["sourceAfterUtc"].clone());
            let clean = crate::startup_log::redact_text(line);
            // Exported identities must not act as fingerprints of a password
            // or token present in the original engine text.
            let source_id = digest(format!(
                "{}:{id}:{source_offset}:{}",
                self.binding,
                digest(clean.as_bytes())
            ));
            let pieces = pieces(&clean);
            let failure_kind = technical_failure(channel, &clean);
            let mut line_records = Vec::new();
            for (part, text) in pieces.iter().enumerate() {
                line_records.push(json!({"sourceRecordId":source_id,"part":part + 1,"parts":pieces.len(),"sourceOffset":source_offset,"sourceBytes":end + width,"sourceAfterUtc":after,"capturedAt":captured_at,"channel":channel,"failureKind":failure_kind,"result":if failure_kind.is_some() {"failure"} else {"observed"},"text":text}));
            }
            let expanded: usize = line_records
                .iter()
                .map(|record| record.to_string().len())
                .sum();
            if technical_lines >= 256 || total_record_bytes + expanded > 128 * 1024 {
                self.cursor["offset"] = json!(source_offset);
                break;
            }
            technical_lines += 1;
            total_record_bytes += expanded;
            for record in line_records {
                let size = record.to_string().len();
                if record_bytes + size > 6 * 1024 {
                    self.flush(log, &mut records, owned)?;
                    record_bytes = 0;
                }
                records.push(record);
                record_bytes += size;
            }
            increment(&mut self.cursor, "technical");
        }
        self.flush(log, &mut records, owned)?;
        let committed_offset = self.cursor["offset"]
            .as_u64()
            .ok_or("CS2 技术日志游标无效。")?;
        self.cursor["anchor"] = json!(anchor(&mut file, committed_offset).map_err(failure)?);
        if identity(&file).map_err(failure)? != id
            || file.metadata().map_err(failure)?.len() < committed_offset
        {
            return Err("CS2 技术日志读取期间来源变化，游标保留供重读。".into());
        }
        self.cursor["backlogBytes"] = json!(length.saturating_sub(committed_offset));
        if !owned() {
            return Err("console_capture_interrupted: process_ended_before_cursor_commit".into());
        }
        self.active(log)?;
        if committed_offset != offset
            || changed
            || rewritten
            || first_file
            || old_backlog != self.cursor["backlogBytes"]
            || old_invalid != self.cursor["invalid"]
        {
            log.committed_event(
                "cs2_console_coverage",
                "observed",
                Some(&self.health().to_string()),
            )
            .map_err(failure)?;
            let directory = state_directory(log);
            fs::create_dir_all(&directory).map_err(failure)?;
            parents(&directory.join(CURSOR)).map_err(failure)?;
            let state = serde_json::to_vec(&self.cursor).map_err(failure)?;
            if state.len() > STATE_BYTES {
                return Err("CS2 技术日志游标超过预算。".into());
            }
            crate::cs2_session::atomic_write(&directory.join(CURSOR), &state)?;
        }
        Ok(self.health())
    }
}
fn increment(value: &mut Value, field: &str) {
    value[field] = json!(value[field].as_u64().unwrap_or(0).saturating_add(1));
}
fn newline(bytes: &[u8], mode: &str) -> Option<(usize, usize)> {
    if mode == "utf8" {
        bytes
            .iter()
            .position(|byte| *byte == 10)
            .map(|index| (index, 1))
    } else {
        bytes
            .chunks_exact(2)
            .position(|value| {
                if mode == "utf16le" {
                    value == [10, 0]
                } else {
                    value == [0, 10]
                }
            })
            .map(|index| (index * 2, 2))
    }
}
fn decode(bytes: &[u8], mode: &str) -> Result<String, ()> {
    if mode == "utf8" {
        return String::from_utf8(bytes.to_vec()).map_err(|_| ());
    }
    if bytes.len() % 2 != 0 {
        return Err(());
    }
    let words: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|value| {
            if mode == "utf16le" {
                u16::from_le_bytes([value[0], value[1]])
            } else {
                u16::from_be_bytes([value[0], value[1]])
            }
        })
        .collect();
    String::from_utf16(&words).map_err(|_| ())
}
// CS2 -condebug prefixes file lines with MM/DD HH:MM:SS. Only remove a
// structurally valid engine prefix for classification; the retained evidence
// keeps the original line and its independently observed UTC interval.
fn console_body(line: &str) -> &str {
    let bytes = line.as_bytes();
    if bytes.len() >= 15
        && [(2, b'/'), (5, b' '), (8, b':'), (11, b':'), (14, b' ')]
            .iter()
            .all(|(i, b)| bytes[*i] == *b)
        && [0, 1, 3, 4, 6, 7, 9, 10, 12, 13]
            .iter()
            .all(|i| bytes[*i].is_ascii_digit())
    {
        let pair = |i: usize| (bytes[i] - b'0') * 10 + bytes[i + 1] - b'0';
        if (1..=12).contains(&pair(0))
            && (1..=31).contains(&pair(3))
            && pair(6) < 24
            && pair(9) < 60
            && pair(12) < 60
        {
            return &line[15..];
        }
    }
    line
}
enum Category<'a> {
    Chat,
    Unknown,
    Technical(&'a str),
}
fn category(line: &str) -> Category<'_> {
    let lower = line.to_lowercase();
    if [
        "[all]",
        "[team]",
        "(team)",
        "*dead*",
        "say_team",
        "say ",
        "privatechat",
        "chatmessage",
    ]
    .iter()
    .any(|value| lower.contains(value))
    {
        return Category::Chat;
    }
    let line = console_body(line.trim_start());
    let Some(rest) = line.strip_prefix('[') else {
        return Category::Unknown;
    };
    let Some((channel, body)) = rest.split_once(']') else {
        return Category::Unknown;
    };
    if channel == "Client"
        && [
            "Ignoring CSVCMsg_UserCommands_t: Missing command to delta from",
            "Ignoring CSVCMsg_UserCommands_t with no command data",
        ]
        .iter()
        .any(|prefix| body.trim_start().starts_with(prefix))
    {
        return Category::Technical(channel);
    }
    if [
        "Networking",
        "NetworkSystem",
        "SteamNetSockets",
        "SteamNetworkingSockets",
        "NetSteamConn",
        "GameStateIntegration",
        "GSI",
        "RenderSystem",
        "RenderSystemDX11",
        "ResourceSystem",
        "MaterialSystem",
        "EngineServiceManager",
        "VProf",
    ]
    .contains(&channel)
    {
        let body = body.trim_start().to_ascii_lowercase();
        let recognized = [
            "error: ",
            "failed ",
            "failure: ",
            "warning: ",
            "fatal: ",
            "assertion ",
            "connection ",
            "connecting ",
            "connected ",
            "disconnect ",
            "disconnected ",
            "timed out ",
            "timeout ",
            "steamnetworkingsockets ",
            "steamnetsockets ",
            "network ",
            "http ",
            "post ",
            "request ",
            "response ",
            "gsi ",
            "game state integration ",
            "creating ",
            "created ",
            "initializing ",
            "initialized ",
            "using ",
            "swapchain ",
            "present ",
            "device ",
            "shader ",
            "texture ",
            "dxgi_",
            "d3d",
            "vulkan ",
            "loading ",
            "loaded ",
            "resource ",
            "material ",
            "frame ",
            "frames ",
            "total ",
            "fps ",
        ]
        .iter()
        .any(|prefix| body.starts_with(prefix));
        if recognized {
            Category::Technical(channel)
        } else {
            Category::Unknown
        }
    } else {
        Category::Unknown
    }
}
fn technical_failure(channel: &str, line: &str) -> Option<&'static str> {
    let body = line.split_once(']')?.1.trim_start().to_ascii_lowercase();
    if ["RenderSystem", "RenderSystemDX11", "MaterialSystem"].contains(&channel)
        && (body.starts_with("error: ")
            || body.starts_with("failed ")
            || body.starts_with("device lost")
            || body.starts_with("dxgi_"))
        && (body.contains("dxgi_error_device_removed")
            || body.contains("dxgi_error_device_hung")
            || body.starts_with("device lost"))
    {
        Some("graphics_device_lost")
    } else if body.starts_with("error: ") {
        Some("engine_error")
    } else if body.starts_with("failed ") || body.starts_with("failure: ") {
        Some("engine_failure")
    } else if body.starts_with("fatal: ") || body.starts_with("assertion ") {
        Some("engine_fatal")
    } else if body.starts_with("timed out ") || body.starts_with("timeout ") {
        Some("technical_timeout")
    } else {
        None
    }
}
fn pieces(text: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + 1024).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        result.push(&text[start..end]);
        start = end;
    }
    result
}
fn valid_time(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_ok())
}
fn valid_cursor(value: &Value) -> bool {
    value["offset"].as_u64().is_some()
        && value["anchor"].as_str().is_some_and(|value| {
            value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        && ["utf8", "utf16le", "utf16be"].contains(&value["encoding"].as_str().unwrap_or_default())
        && (value["identity"].is_null()
            || value["identity"].as_str().is_some_and(|value| {
                value.len() <= 128
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b':')
            }))
        && value["observations"].as_array().is_some_and(|values| {
            values.len() <= 16
                && values
                    .iter()
                    .all(|value| value["offset"].as_u64().is_some() && valid_time(&value["after"]))
        })
        && (value["sourceAfterUtc"].is_null() || valid_time(&value["sourceAfterUtc"]))
        && value["discarding"].is_boolean()
        && ["technical", "unknown", "chat", "invalid", "gaps"]
            .iter()
            .all(|key| value[*key].as_u64().is_some())
        && (value["backlogBytes"].is_null() || value["backlogBytes"].as_u64().is_some())
}

static RUNTIME: std::sync::Mutex<Value> = std::sync::Mutex::new(Value::Null);
pub fn status(log: &DesktopLog) -> Result<Value, String> {
    let mut config = settings(log)?;
    config["runtime"] = RUNTIME.lock().map_err(failure)?.clone();
    Ok(config)
}
#[cfg(windows)]
pub fn run_worker(log: DesktopLog, running: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use std::{
        sync::atomic::Ordering,
        thread,
        time::{Duration, Instant},
    };
    let mut capture: Option<Capture> = None;
    let mut last_signature = String::new();
    let mut failures: u64 = 0;
    while running.load(Ordering::Acquire) {
        let result: Result<Value, String> = (|| {
            let config = settings(&log)?;
            if config["enabled"] != true {
                capture = None;
                return Ok(json!({"phase":"disabled"}));
            }
            let Some(journal) =
                crate::cs2_session::SessionStore::new(log.state_root.clone()).load()?
            else {
                capture = None;
                return Ok(json!({"phase":"waiting_for_managed_launch"}));
            };
            let Some(process) = crate::managed_cs2::verified_session_process(&journal, &log)?
            else {
                let had_capture = capture.take().is_some();
                return Ok(
                    json!({"phase":"owned_process_unavailable","tail":"not read without current process proof","capturePreviouslyActive":had_capture}),
                );
            };
            if journal["consoleDiagnostics"]["version"] != 1 {
                capture = None;
                return Ok(
                    json!({"phase":if journal["consoleDiagnosticsWarning"].is_null() {"next_launch_required"} else {"unavailable"},"reason":journal["consoleDiagnosticsWarning"]}),
                );
            }
            let binding = Capture::binding(&journal);
            if capture.as_ref().is_none_or(|value| {
                value.binding != binding
                    || config["generation"].as_str() != Some(value.generation.as_str())
            }) {
                capture = Some(Capture::new(&log, &journal)?);
            }
            capture
                .as_mut()
                .ok_or("CS2 技术日志读取状态缺失。")?
                .poll(&log, &|| {
                    process.is_running() && running.load(Ordering::Acquire)
                })
        })();
        let (mut snapshot, signature, failed) = match result {
            Ok(value) => {
                let signature = json!({"phase":value["phase"],"binding":value["binding"],"reason":value["reason"]}).to_string();
                (value, signature, false)
            }
            Err(error) if error.starts_with("console_capture_interrupted:") => {
                let signature = error.clone();
                (
                    json!({"phase":"interrupted","reason":error,"cursor":"unchanged; no completion claimed"}),
                    signature,
                    false,
                )
            }
            Err(error) => {
                let signature = error.clone();
                (
                    json!({"phase":"unavailable","error":error,"retry":"bounded background poll; original cursor retained"}),
                    signature,
                    true,
                )
            }
        };
        let changed = signature != last_signature;
        failures = if failed {
            if changed {
                1
            } else {
                failures.saturating_add(1)
            }
        } else {
            0
        };
        snapshot["lastObservedAt"] = json!(utc());
        snapshot["failureObservations"] = json!(failures);
        if let Ok(mut state) = RUNTIME.lock() {
            *state = snapshot.clone();
        }
        if changed || (failed && failures.is_power_of_two()) {
            log.event(
                "cs2_console_monitor",
                if failed { "failure" } else { "observed" },
                Some(&json!({"state":snapshot,"occurrences":failures}).to_string()),
            );
            last_signature = signature;
        }
        let until = Instant::now() + Duration::from_secs(1);
        while running.load(Ordering::Acquire) && Instant::now() < until {
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn setup(name: &str) -> (PathBuf, DesktopLog, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "mizar-console-{name}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let executable = root.join("game/bin/win64/cs2.exe");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir_all(root.join("game/csgo")).unwrap();
        fs::write(&executable, b"public fixture, never executed").unwrap();
        let log = DesktopLog::new(&root, None).unwrap();
        (root, log, executable)
    }
    fn journal(log: &DesktopLog, executable: &Path) -> Value {
        json!({"pid":42,"created":99,"launchTime":100,"executable":executable,"consoleDiagnostics":prepare(log, executable).unwrap().unwrap()})
    }
    fn change(log: &DesktopLog, enabled: bool) -> Result<Value, String> {
        let current = settings(log)?;
        set_enabled(log, enabled, current["generation"].as_str())
    }
    fn append(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
    }
    fn records(log: &DesktopLog) -> Vec<Value> {
        let mut result = Vec::new();
        for name in [
            "desktop.ndjson",
            "desktop.1.ndjson",
            "desktop.2.ndjson",
            "desktop.3.ndjson",
        ] {
            let Ok(text) = fs::read_to_string(log.directory.join(name)) else {
                continue;
            };
            for line in text.lines() {
                let event: Value = serde_json::from_str(line).unwrap();
                if event["stage"] == "cs2_console_records" {
                    let detail: Value =
                        serde_json::from_str(event["detail"].as_str().unwrap()).unwrap();
                    result.extend(detail["records"].as_array().unwrap().clone());
                }
            }
        }
        result
    }

    #[test]
    fn persists_only_new_recognized_technical_lines_and_resumes_partial_utf8_after_restart() {
        let (root, log, executable) = setup("restart");
        let source = path(&executable).unwrap();
        fs::write(&source, b"[RenderSystem] Error: PRE_SESSION_PRIVATE\n").unwrap();
        assert_eq!(settings(&log).unwrap()["enabled"], false);
        assert!(prepare(&log, &executable).unwrap().is_none());
        change(&log, true).unwrap();
        let launch = journal(&log, &executable);
        let mut capture = Capture::new(&log, &launch).unwrap();
        append(&source, b"[RenderSystem] Created device successfully\n08/06 05:12:46 [Client] Ignoring CSVCMsg_UserCommands_t: Missing command to delta from\n[Client] Ignoring CSVCMsg_UserCommands_t with no command data\n[Networking] Error: connection failed cause=EACCES token=PRIVATE_CONSOLE_CREDENTIAL\n[ALL] player PRIVATE_CHAT\n[Networking] say_team PRIVATE_TEAM_CHAT\n[RenderSystem] PRIVATE_UNKNOWN_PAYLOAD\n\xff\n[GSI] HTTP POST pending");
        let health = capture.poll(&log, &|| true).unwrap();
        assert_eq!(health["technical"], 4);
        assert_eq!(health["chat"], 2);
        assert_eq!(health["unknown"], 1);
        assert_eq!(health["invalid"], 1);
        let first = records(&log);
        assert_eq!(first.len(), 4);
        let text = serde_json::to_string(&first).unwrap();
        for absent in [
            "PRE_SESSION_PRIVATE",
            "PRIVATE_CHAT",
            "PRIVATE_TEAM_CHAT",
            "PRIVATE_UNKNOWN_PAYLOAD",
            "PRIVATE_CONSOLE_CREDENTIAL",
        ] {
            assert!(!text.contains(absent), "{absent}");
        }
        assert!(text.contains("EACCES"));
        assert!(text.contains("08/06 05:12:46 [Client] Ignoring CSVCMsg_UserCommands_t: Missing command to delta from"));
        assert!(text.contains("Ignoring CSVCMsg_UserCommands_t with no command data"));
        assert!(matches!(
            category("08/06 05:12:46 [ALL] private chat"),
            Category::Chat
        ));
        assert!(matches!(
            category(
                "99/99 99:99:99 [Client] Ignoring CSVCMsg_UserCommands_t with no command data"
            ),
            Category::Unknown
        ));
        assert!(text.contains("Created device successfully"));
        assert!(text.contains("[redacted]"));
        assert!(first
            .iter()
            .all(|value| valid_time(&value["sourceAfterUtc"]) && valid_time(&value["capturedAt"])));
        drop(capture);
        let mut restarted = Capture::new(&log, &launch).unwrap();
        append(&source, b" completed\n");
        assert_eq!(restarted.poll(&log, &|| true).unwrap()["technical"], 5);
        let all = records(&log);
        assert_eq!(all.len(), 5);
        assert_eq!(
            all.iter()
                .filter(|value| value["sourceRecordId"] == first[0]["sourceRecordId"])
                .count(),
            1
        );
        assert!(serde_json::to_string(&all)
            .unwrap()
            .contains("HTTP POST pending completed"));
        assert!(!fs::read_to_string(state_directory(&log).join(CURSOR))
            .unwrap()
            .contains("PRIVATE"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn respects_owned_process_and_revocation_before_reading_and_skips_the_disabled_interval() {
        let (root, log, executable) = setup("ownership");
        let source = path(&executable).unwrap();
        change(&log, true).unwrap();
        let launch = journal(&log, &executable);
        let mut capture = Capture::new(&log, &launch).unwrap();
        append(&source, b"[GSI] HTTP POST PRIVATE_DISABLED_INTERVAL\n");
        assert!(capture.poll(&log, &|| false).is_err());
        assert!(records(&log).is_empty());
        change(&log, false).unwrap();
        assert!(capture.poll(&log, &|| true).is_err());
        change(&log, true).unwrap();
        let mut enabled = Capture::new(&log, &launch).unwrap();
        append(&source, b"[GSI] HTTP POST new enabled operation\n");
        enabled.poll(&log, &|| true).unwrap();
        let text = serde_json::to_string(&records(&log)).unwrap();
        assert!(text.contains("new enabled operation"));
        assert!(!text.contains("PRIVATE_DISABLED_INTERVAL"));
        let mut without_flag = launch;
        without_flag["consoleDiagnostics"] = Value::Null;
        assert!(Capture::new(&log, &without_flag).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_the_original_cursor_on_real_log_io_failure_and_retries_the_full_line() {
        let (root, log, executable) = setup("io");
        let source = path(&executable).unwrap();
        change(&log, true).unwrap();
        let launch = journal(&log, &executable);
        let mut capture = Capture::new(&log, &launch).unwrap();
        append(
            &source,
            b"[RenderSystem] Error: original device loss cause=DXGI_ERROR_DEVICE_REMOVED\n",
        );
        let backup = root.join("logs-while-blocked");
        fs::rename(&log.directory, &backup).unwrap();
        fs::write(&log.directory, b"public synthetic storage failure").unwrap();
        let error = capture.poll(&log, &|| true).unwrap_err();
        assert!(error.contains("CS2 技术日志不可读取"));
        assert!(!state_directory(&log).join(CURSOR).exists());
        fs::remove_file(&log.directory).unwrap();
        fs::rename(&backup, &log.directory).unwrap();
        capture.poll(&log, &|| true).unwrap();
        let before = records(&log);
        assert_eq!(before.len(), 1);
        assert!(before[0]["text"]
            .as_str()
            .unwrap()
            .contains("DXGI_ERROR_DEVICE_REMOVED"));
        capture.poll(&log, &|| true).unwrap();
        assert_eq!(records(&log), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounds_each_poll_without_dropping_backlog_and_rejects_linked_sources() {
        let (root, log, executable) = setup("bounds");
        let source = path(&executable).unwrap();
        change(&log, true).unwrap();
        let launch = journal(&log, &executable);
        let mut capture = Capture::new(&log, &launch).unwrap();
        append(
            &source,
            "[GSI] HTTP POST technical operation\n"
                .repeat(600)
                .as_bytes(),
        );
        let first = capture.poll(&log, &|| true).unwrap();
        assert!(first["technical"].as_u64().unwrap() <= 256);
        assert!(first["backlogBytes"].as_u64().unwrap() > 0);
        for _ in 0..10 {
            if capture.poll(&log, &|| true).unwrap()["backlogBytes"] == 0 {
                break;
            }
        }
        assert_eq!(capture.health()["technical"], 600);
        let all = records(&log);
        assert_eq!(all.len(), 600);
        let identities: std::collections::HashSet<_> = all
            .iter()
            .map(|value| value["sourceRecordId"].as_str().unwrap())
            .collect();
        assert_eq!(identities.len(), 600);
        let other = root.join("private-unrelated.txt");
        fs::hard_link(&source, &other).unwrap();
        assert!(checked(&source).is_err());
        assert_eq!(records(&log).len(), 600);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn decodes_partial_utf16_and_marks_replaced_source_time_unknown_until_a_new_observed_eof() {
        for big_endian in [false, true] {
            let (root, log, executable) = setup(if big_endian { "utf16be" } else { "utf16le" });
            let source = path(&executable).unwrap();
            fs::write(&source, if big_endian { [254, 255] } else { [255, 254] }).unwrap();
            change(&log, true).unwrap();
            let launch = journal(&log, &executable);
            let mut capture = Capture::new(&log, &launch).unwrap();
            let encoded = |text: &str| {
                text.encode_utf16()
                    .flat_map(|word| {
                        if big_endian {
                            word.to_be_bytes()
                        } else {
                            word.to_le_bytes()
                        }
                    })
                    .collect::<Vec<_>>()
            };
            let text = "[GSI] HTTP POST 已完成\r\n";
            let bytes = encoded(text);
            append(&source, &bytes[..3]);
            assert_eq!(capture.poll(&log, &|| true).unwrap()["technical"], 0);
            append(&source, &bytes[3..]);
            assert_eq!(capture.poll(&log, &|| true).unwrap()["technical"], 1);
            assert!(records(&log)[0]["text"]
                .as_str()
                .unwrap()
                .contains("已完成"));
            let mut replacement = if big_endian {
                vec![254, 255]
            } else {
                vec![255, 254]
            };
            replacement.extend(encoded("[GSI] HTTP POST replacement\n"));
            fs::write(&source, replacement).unwrap();
            capture.poll(&log, &|| true).unwrap();
            assert!(records(&log).last().unwrap()["sourceAfterUtc"].is_null());
            append(&source, &encoded("[GSI] HTTP POST after known EOF\n"));
            capture.poll(&log, &|| true).unwrap();
            assert!(valid_time(&records(&log).last().unwrap()["sourceAfterUtc"]));
            assert_eq!(capture.health()["gaps"], 1);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn durable_disable_fences_restored_enable_documents_and_stale_requests_without_clearing_game_logs(
    ) {
        let (root, log, executable) = setup("consent-race");
        let enabled = change(&log, true).unwrap();
        let launch = journal(&log, &executable);
        let mut capture = Capture::new(&log, &launch).unwrap();
        let directory = state_directory(&log);
        let backup = root.join("diagnostics-restored-later");
        fs::rename(&directory, &backup).unwrap();
        fs::write(&directory, b"public metadata directory unavailable").unwrap();
        let disabled = set_enabled(&log, false, enabled["generation"].as_str()).unwrap();
        assert_eq!(disabled["enabled"], false);
        fs::remove_file(&directory).unwrap();
        fs::rename(backup, &directory).unwrap();
        assert_eq!(settings(&log).unwrap()["enabled"], false);
        assert!(set_enabled(&log, true, enabled["generation"].as_str()).is_err());
        let source = path(&executable).unwrap();
        append(&source, b"[GSI] HTTP POST PRIVATE_DISABLED_WINDOW\n");
        assert!(capture.poll(&log, &|| true).is_err());
        let actual = change(&log, true).unwrap();
        let repeated = set_enabled(&log, true, disabled["generation"].as_str()).unwrap();
        assert_eq!(repeated["generation"], actual["generation"]);
        let mut fresh = Capture::new(&log, &launch).unwrap();
        append(&source, b"[GSI] HTTP POST renewed operation\n");
        fresh.poll(&log, &|| true).unwrap();
        assert!(!serde_json::to_string(&records(&log))
            .unwrap()
            .contains("PRIVATE_DISABLED_WINDOW"));
        assert!(fs::read_to_string(source)
            .unwrap()
            .contains("PRIVATE_DISABLED_WINDOW"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exports_public_fixture_to_the_node_pipeline() {
        let (root, log, executable) = setup("pipeline");
        let source = path(&executable).unwrap();
        fs::write(&source, b"[GSI] HTTP POST PRIVATE_PRESESSION_CONTENT\n").unwrap();
        change(&log, true).unwrap();
        let launch = journal(&log, &executable);
        let mut capture = Capture::new(&log, &launch).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        append(&source, b"[RenderSystem] Created device for public fixture\n[RenderSystem] Error: device lost DXGI_ERROR_DEVICE_REMOVED token=PRIVATE_CONSOLE_TOKEN cause=original-device-removal\n[ALL] player PRIVATE_CHAT_CONTENT\n[RenderSystem] PRIVATE_UNKNOWN_CONTENT\n");
        capture.poll(&log, &|| true).unwrap();
        let captured = records(&log);
        assert_eq!(captured.len(), 2);
        assert_eq!(captured[1]["failureKind"], "graphics_device_lost");
        if let Some(destination) = std::env::var_os("MIZAR_CONSOLE_TEST_OUTPUT_DIRECTORY") {
            let destination = PathBuf::from(destination);
            assert!(
                destination.is_dir(),
                "consumer creates its own fresh temporary directory"
            );
            let output = destination.join("logs");
            fs::create_dir(&output).unwrap();
            for name in [
                "desktop.ndjson",
                "desktop.1.ndjson",
                "desktop.2.ndjson",
                "desktop.3.ndjson",
            ] {
                if log.directory.join(name).exists() {
                    fs::copy(log.directory.join(name), output.join(name)).unwrap();
                }
            }
            fs::write(destination.join("console-producer.json"), json!({"scope":"public synthetic fixture from real Rust capture and DesktopLog; process proof tested separately", "records":captured, "health":capture.health()}).to_string()).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
}
