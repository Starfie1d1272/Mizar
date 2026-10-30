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
pub(crate) fn utc() -> String {
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
    // Windows packaged-app file virtualization can map a plain named path to
    // LocalCache without making any visible ancestor a reparse point. Resolve
    // the name through the same OS view and recheck ancestors before comparing
    // it with the already-open handle. checked() also reopens and compares IDs.
    parents(path)?;
    let expected = fs::canonicalize(path)?;
    parents(path)?;
    let expected = expected
        .to_str()
        .ok_or_else(|| io::Error::other("console path encoding invalid"))?;
    let normalize = |value: &str| {
        let value = value.replace('/', "\\");
        Path::new(value.strip_prefix("\\\\?\\").unwrap_or(&value))
            .components()
            .collect::<PathBuf>()
            .to_string_lossy()
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
static CHAT_MIGRATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
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
    migrate_chat_default(log)?;
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
        Ok(None) => {
            json!({"version":1,"enabled":true,"generation":digest("default-console-capture-v1")})
        }
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
fn migrate_chat_default(log: &DesktopLog) -> Result<(), String> {
    let _guard = CHAT_MIGRATION.lock().map_err(failure)?;
    let marker = log.state_root.join("chat-setting-v1.flag");
    match checked(&marker) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(failure(error)),
    }
    let directory = state_directory(log);
    fs::create_dir_all(&directory).map_err(failure)?;
    parents(&directory.join(SETTINGS)).map_err(failure)?;
    // Keep the existing file and disable fence subject to the same path checks
    // as normal reads before replacing either during the one-time migration.
    read_state(&directory.join(SETTINGS)).map_err(failure)?;
    marker_generation(log)?;
    let value = json!({"version":1,"enabled":true,"generation":generation(),"changedAt":utc()});
    crate::cs2_session::atomic_write(
        &directory.join(SETTINGS),
        &serde_json::to_vec(&value).map_err(failure)?,
    )?;
    match fs::remove_file(disabled_marker(log)) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(failure(error)),
    }
    DISABLED_ROOTS
        .lock()
        .map_err(failure)?
        .remove(&log.state_root);
    parents(&marker).map_err(failure)?;
    crate::cs2_session::atomic_write(&marker, b"1")?;
    Ok(())
}
pub fn set_enabled(
    log: &DesktopLog,
    enabled: bool,
    expected_generation: Option<&str>,
) -> Result<Value, String> {
    migrate_chat_default(log)?;
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
/// Called before the Steam request, after discovery. Pre-session text is never exported.
pub fn prepare(log: &DesktopLog, executable: &Path) -> Result<Option<Value>, String> {
    if settings(log)?["enabled"] == true {
        preserve_previous_console(log, executable)
            .map_err(|error| format!("raw_console_preservation_failed: {error}"))?;
    }
    boundary(log, executable)
}
/// A newly authorized borrowed source starts at the current file boundary.
/// It never creates a managed lifecycle journal or reads pre-attachment chat.
pub fn boundary(log: &DesktopLog, executable: &Path) -> Result<Option<Value>, String> {
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

// Raw engine output remains local and outside diagnostic exports. Content-addressed
// copies survive the engine truncating console.log on the next managed launch.
fn preserve_previous_console(log: &DesktopLog, executable: &Path) -> io::Result<()> {
    use std::io::Write;

    const FILE_LIMIT: u64 = 512 * 1024 * 1024;
    const TOTAL_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
    let (mut source, source_identity) = match checked(&path(executable).map_err(io::Error::other)?)
    {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let before = source.metadata()?;
    if before.len() == 0 {
        return Ok(());
    }
    if before.len() > FILE_LIMIT {
        return Err(io::Error::other("raw_console_file_budget"));
    }
    let directory = log.state_root.join("console-history");
    parents(&directory.join("probe")).or_else(|error| {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
        fs::create_dir(&directory)?;
        parents(&directory.join("probe"))
    })?;
    let temporary = directory.join(format!(
        ".capture-{}-{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut copied = 0u64;
        loop {
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            copied += count as u64;
            if copied > FILE_LIMIT {
                return Err(io::Error::other("raw_console_file_budget"));
            }
            output.write_all(&buffer[..count])?;
            hasher.update(&buffer[..count]);
        }
        let after = source.metadata()?;
        if copied != before.len()
            || after.len() != before.len()
            || after.modified()? != before.modified()?
            || identity(&source)? != source_identity
        {
            return Err(io::Error::other("raw_console_changed_during_capture"));
        }
        let target = directory.join(format!("{:x}.log", hasher.finalize()));
        if target.exists() {
            let (mut existing, _) = checked(&target)?;
            let mut hash = Sha256::new();
            loop {
                let count = existing.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            if format!("{:x}.log", hash.finalize()) != target.file_name().unwrap().to_string_lossy()
            {
                return Err(io::Error::other("raw_console_existing_copy_corrupt"));
            }
            return Ok(());
        }
        let mut total = copied;
        let mut count = 0;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.path() == temporary {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() || !plain(&metadata) {
                return Err(io::Error::other("raw_console_history_unsafe"));
            }
            count += 1;
            total += metadata.len();
        }
        if count >= 16 || total > TOTAL_LIMIT {
            return Err(io::Error::other("raw_console_history_budget"));
        }
        output.sync_all()?;
        drop(output);
        // Hard-link commits without replacing an existing file on either platform.
        fs::hard_link(&temporary, &target)?;
        Ok(())
    })();
    let cleanup = fs::remove_file(&temporary);
    result.and(cleanup)
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
            boundary(log, &executable)?.ok_or("CS2 技术日志读取已关闭。")?
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
            if public_chat_boundary(line) && owned() {
                self.active(log)?;
                log.committed_event(
                    "program_all_chat_reset",
                    "observed",
                    Some(&json!({"binding":self.binding,"capturedAt":captured_at}).to_string()),
                )
                .map_err(failure)?;
            }
            let channel = match category(line) {
                Category::Chat => {
                    increment(&mut self.cursor, "chat");
                    if let Some((sender, text)) = public_chat(line) {
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
                        if owned() {
                            self.active(log)?;
                            log.committed_event("program_all_chat", "observed", Some(&json!({"binding":self.binding,"id":digest(format!("{}:{id}:{source_offset}",self.binding)),"sourceAfterUtc":after,"capturedAt":captured_at,"sender":sender,"text":text}).to_string())).map_err(failure)?;
                        }
                    }
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

fn public_chat(line: &str) -> Option<(String, String)> {
    let body = console_body(line.trim_start())
        .trim_start()
        .strip_prefix("[ALL] ")?;
    let (sender, text) = body.split_once('：').or_else(|| body.split_once(": "))?;
    let clean = |text: &str| {
        text.chars()
            .filter(|c| {
                !c.is_control() && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
            .collect::<String>()
            .trim()
            .to_owned()
    };
    let sender = clean(sender);
    let text = clean(text);
    if sender.is_empty()
        || text.is_empty()
        || sender.chars().count() > 128
        || text.chars().count() > 512
    {
        return None;
    }
    Some((sender, text))
}

fn public_chat_boundary(line: &str) -> bool {
    let body = console_body(line.trim_start()).trim_start();
    [
        "[Demo] Requesting playback of ",
        "[HostStateManager] HostStateRequest::Start(",
        "[HostStateManager] Host activate:",
        "Loading map \"",
    ]
    .iter()
    .any(|prefix| body.starts_with(prefix))
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
pub fn run_worker(
    log: DesktopLog,
    running: std::sync::Arc<std::sync::atomic::AtomicBool>,
    app: tauri::AppHandle,
) {
    use std::{
        sync::atomic::Ordering,
        thread,
        time::{Duration, Instant},
    };
    use tauri::Manager;
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
            let source = {
                let state = app.state::<std::sync::Mutex<crate::managed_cs2::ManagedCs2>>();
                let Ok(cs2) = state.try_lock() else {
                    return Ok(json!({"phase":"source_busy"}));
                };
                cs2.console_source()?
            };
            let Some((journal, process)) = source else {
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
                    process.is_running() && running.load(Ordering::Acquire) && {
                        let state = app.state::<std::sync::Mutex<crate::managed_cs2::ManagedCs2>>();
                        state
                            .try_lock()
                            .ok()
                            .and_then(|cs2| {
                                cs2.console_source()
                                    .ok()
                                    .flatten()
                                    .map(|(_, process)| process)
                            })
                            .is_some_and(|current| {
                                current.pid == process.pid
                                    && current.created == process.created
                                    && current.is_running()
                            })
                    }
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
