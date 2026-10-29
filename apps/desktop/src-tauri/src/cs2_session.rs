//! Durable physical configuration transaction; production state remains in Companion.
use crate::cs2_video;
use crate::{cs2_frame_rate, cs2_preferences::Preferences};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn full_recovery_warning(code: &str) -> &'static str {
    match code {
        "conflict" => "观战键位已被其他程序修改，保留当前配置和原备份；请核对后重试。",
        "identity_changed" | "identity_invalid" | "identity" | "path_invalid" => "无法确认原账号或安装位置，观战键位备份仍保留。",
        "damaged" | "snapshot_invalid" | "snapshot_file_invalid" | "snapshot_changed" => "观战键位备份校验失败，原备份仍保留。",
        _ => "暂时无法恢复观战键位，原备份仍保留；请检查文件访问后重试。",
    }
}

/// Missing game identity after a submitted Steam request is not proof of exit.
pub fn unconfirmed_launch(value: &Value) -> bool {
    value["launchAttempted"] == true
        && value["launchCancelled"] != true
        && (value["pid"].as_u64().is_none() || value["created"].as_u64().is_none())
}

/// Preserve system classification without forwarding custom messages, paths,
/// or configuration bytes to UI, desktop logs, or the user support bundle.
pub(crate) fn io_error(summary: &str, error: &std::io::Error) -> String {
    format!(
        "{summary} [ioKind={:?}; osCode={}]",
        error.kind(),
        error
            .raw_os_error()
            .map_or_else(|| "none".into(), |code| code.to_string())
    )
}

fn json_error(summary: &str, error: &serde_json::Error) -> String {
    format!(
        "{summary} [jsonCategory={:?}; line={}; column={}]",
        error.classify(),
        error.line(),
        error.column()
    )
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("配置路径无效。")?;
    fs::create_dir_all(parent).map_err(|error| io_error("无法创建配置目录。", &error))?;
    let temp = parent.join(format!(
        ".mizar-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| io_error("无法准备配置写入。", &error))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| io_error("配置未能完整保存。", &error))?;
        drop(file);
        replace(&temp, path)?;
        if fs::read(path).map_err(|error| io_error("配置读回验证失败。", &error))? != bytes
        {
            return Err("配置读回验证失败。".into());
        }
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| io_error("配置写入失败，备份仍保留。", &error))
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
        Err(io_error(
            "配置写入失败，备份仍保留。",
            &std::io::Error::last_os_error(),
        ))
    } else {
        Ok(())
    }
}

struct StoreGuard {
    _file: fs::File,
}

pub struct SessionStore {
    root: PathBuf,
}
impl SessionStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: root.join("data/cs2-session"),
        }
    }
    fn acquire_write_guard(&self) -> Result<StoreGuard, String> {
        Ok(StoreGuard {
            _file: crate::spectator_snapshot::acquire(&self.root)?,
        })
    }
    pub(crate) fn full_spectator_pending(&self) -> bool {
        !fs::symlink_metadata(self.root.join("spectator-full-pending.json"))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }
    /// Caller must validate the current Steam account and that CS2 is stopped.
    pub(crate) fn capture_spectator_snapshot(&self, video: &Path, executable: &Path, account: u32, owned: &std::collections::BTreeSet<crate::spectator_recovery_plan::Input>, applied: &crate::spectator_recovery_plan::Bindings) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.capture_spectator_snapshot_locked(&guard, video, executable, account, owned, applied)
    }
    fn capture_spectator_snapshot_locked(&self, _guard: &StoreGuard, video: &Path, executable: &Path, account: u32, owned: &std::collections::BTreeSet<crate::spectator_recovery_plan::Input>, applied: &crate::spectator_recovery_plan::Bindings) -> Result<(), String> {
        if self.load()?.is_some() || self.spectator_pending() { return Err("snapshot_pending".into()); }
        crate::spectator_snapshot::capture(&self.root, video, executable, account, owned, applied, atomic_write)
    }
    /// Explicit session capture; legacy pending records remain exclusive.
    pub(crate) fn capture_spectator_snapshot_for_session(&self, video: &Path, executable: &Path, account: u32, owned: &std::collections::BTreeSet<crate::spectator_recovery_plan::Input>, applied: &crate::spectator_recovery_plan::Bindings, session: &crate::cs2_config_identity::SessionIdentity) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.capture_spectator_snapshot_for_session_locked(&guard, video, executable, account, owned, applied, session)
    }
    fn capture_spectator_snapshot_for_session_locked(&self, _guard: &StoreGuard, video: &Path, executable: &Path, account: u32, owned: &std::collections::BTreeSet<crate::spectator_recovery_plan::Input>, applied: &crate::spectator_recovery_plan::Bindings, session: &crate::cs2_config_identity::SessionIdentity) -> Result<(), String> {
        if self.load()?.is_some() || self.spectator_pending() { return Err("snapshot_pending".into()); }
        crate::spectator_snapshot::capture_for_session(&self.root, video, executable, account, owned, applied, atomic_write, Some(session))
    }
    /// Inspection only; caller supplies independently discovered identity.
    pub(crate) fn spectator_snapshot_status(&self, video: &Path, executable: &Path, account: u32) -> Result<crate::spectator_snapshot::Status, String> {
        let guard = self.acquire_write_guard()?;
        self.spectator_snapshot_status_locked(&guard, video, executable, account)
    }
    fn spectator_snapshot_status_locked(&self, _guard: &StoreGuard, video: &Path, executable: &Path, account: u32) -> Result<crate::spectator_snapshot::Status, String> {
        Ok(crate::spectator_snapshot::status(&self.root, video, executable, account))
    }
    /// Caller must rediscover the same Steam account and confirm CS2 has exited.
    pub(crate) fn recover_spectator_snapshot(&self, video: &Path, executable: &Path, account: u32) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.recover_spectator_snapshot_locked(&guard, video, executable, account)
    }
    fn recover_spectator_snapshot_locked(&self, _guard: &StoreGuard, video: &Path, executable: &Path, account: u32) -> Result<(), String> {
        // A live core journal must be handed off before the associated full
        // record can be removed, including when it belongs to an older session.
        if self.load()?.is_some() { return Err("core_pending".into()); }
        crate::spectator_snapshot::recover(&self.root, video, executable, account, atomic_write)
    }
    /// Caller must verify the active Steam identity and confirm CS2 is stopped.
    pub(crate) fn restore_full_pending(&self, video: &Path, executable: &Path, account: u32) -> Result<Option<String>, String> {
        let guard = self.acquire_write_guard()?;
        if self.load()?.is_some() { return Err("core_pending".into()); }
        if !self.full_spectator_pending() { return Ok(None); }
        if crate::spectator_snapshot::linked_session(&self.root)?.is_some() {
            if crate::spectator_snapshot::finish_unwritten_preparation(&self.root, video, executable, account, atomic_write)? {
                return Ok(None);
            }
            if !crate::spectator_snapshot::has_terminal(&self.root)? { return Err("coordinated_recovery_required".into()); }
        }
        match self.recover_spectator_snapshot_locked(&guard, video, executable, account) {
            Ok(()) => Ok(None),
            Err(error) => Ok(Some(full_recovery_warning(&error).into())),
        }
    }
    pub fn backup_directory(&self) -> PathBuf {
        self.root.clone()
    }
    fn journal_path(&self) -> PathBuf {
        self.root.join("pending.json")
    }
    pub fn load(&self) -> Result<Option<Value>, String> {
        match fs::read(self.journal_path()) {
            Ok(bytes) => {
                if bytes.len() > 4 * 1024 * 1024 {
                    return Err("CS2 恢复记录过大，请检查原配置备份。".into());
                }
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "CS2 恢复记录损坏，请检查原配置备份。")?;
                if value["version"] != 1 && value["version"] != 2 && value["version"] != 3 && value["version"] != 4 {
                    return Err("CS2 恢复记录版本不支持。".into());
                }
                Ok(Some(value))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("无法读取 CS2 恢复记录。".into()),
        }
    }
    pub fn save(&self, value: &Value) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.save_locked(&guard, value)
    }
    fn save_locked(&self, _guard: &StoreGuard, value: &Value) -> Result<(), String> {
        // Ordinary sessions may continue without taking over keys, but cannot
        // adopt a pending full snapshot or arm the ten-key owner.
        let previous = self.load()?;
        let full_pending = self.full_spectator_pending();
        if previous.as_ref().is_some_and(|core| core["fullSnapshot"] == true)
            && value["fullSnapshot"] != true { return Err("snapshot_pending".into()); }
        if value["fullSnapshot"] == true && !full_pending { return Err("snapshot_pending".into()); }
        if full_pending {
            if value["spectatorCfg"] == true { return Err("snapshot_pending".into()); }
            if value["fullSnapshot"] == true {
                let previous = previous.ok_or("snapshot_pending")?;
                let session = crate::cs2_config_identity::SessionIdentity::read(value).map_err(str::to_string)?.ok_or("snapshot_pending")?;
                if previous["fullSnapshot"] != true
                    || crate::cs2_config_identity::SessionIdentity::read(&previous).map_err(str::to_string)?.as_ref() != Some(&session)
                    || crate::spectator_snapshot::linked_session(&self.root)?.as_ref() != Some(&session)
                    || crate::spectator_snapshot::has_terminal(&self.root)? {
                    return Err("snapshot_pending".into());
                }
                let mut old = previous.clone(); let mut next = value.clone();
                if value["consoleDiagnostics"].is_null() {
                    old.as_object_mut().ok_or("snapshot_invalid")?.remove("consoleDiagnostics");
                    next.as_object_mut().ok_or("snapshot_invalid")?.remove("consoleDiagnostics");
                }
                for key in ["launchAttempted", "launchTime", "launchCancelled", "pid", "created", "mulnxLaunch"] {
                    old.as_object_mut().ok_or("snapshot_invalid")?.remove(key);
                    next.as_object_mut().ok_or("snapshot_invalid")?.remove(key);
                }
                if old != next || !value["launchAttempted"].is_boolean()
                    || (!value["launchCancelled"].is_null() && !value["launchCancelled"].is_boolean())
                    || (!value["launchTime"].is_null() && value["launchTime"].as_u64().is_none())
                    || (!value["pid"].is_null() && value["pid"].as_u64().is_none())
                    || (!value["created"].is_null() && value["created"].as_u64().is_none())
                    || (!value["mulnxLaunch"].is_null() && value["mulnxLaunch"] != true)
                    || (previous["mulnxLaunch"] == true && value["mulnxLaunch"] != true)
                    || (previous["launchAttempted"] == true && previous["mulnxLaunch"] != value["mulnxLaunch"])
                    || value["pid"].is_null() != value["created"].is_null()
                    || (previous["launchAttempted"] == true && value["launchAttempted"] != true)
                    || (previous["launchCancelled"] == true && value["launchCancelled"] != true)
                    || (!previous["launchTime"].is_null() && previous["launchTime"] != value["launchTime"])
                    || (!previous["pid"].is_null() && previous["pid"] != value["pid"])
                    || (!previous["created"].is_null() && previous["created"] != value["created"]) {
                    return Err("snapshot_pending".into());
                }
            }
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "CS2 恢复记录无法保存。")?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("CS2 恢复记录过大，未修改游戏设置。".into());
        }
        atomic_write(&self.journal_path(), &bytes)
    }
    fn spectator_path(&self) -> PathBuf {
        self.root.join("spectator-recovery.json")
    }
    pub fn spectator_pending(&self) -> bool {
        !fs::symlink_metadata(self.spectator_path())
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }
    fn spectator_record(&self) -> Result<Option<Value>, String> {
        let metadata = match fs::symlink_metadata(self.spectator_path()) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(io_error(
                    "观战恢复记录无法读取，请打开备份目录检查。",
                    &error,
                ))
            }
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 * 1024
        {
            return Err("观战恢复记录格式或大小异常，请打开备份目录检查。".into());
        }
        let bytes = fs::read(self.spectator_path())
            .map_err(|error| io_error("观战恢复记录无法读取。", &error))?;
        if bytes.len() > 1024 * 1024 {
            return Err("观战恢复记录过大。".into());
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| json_error("观战恢复记录损坏，请打开备份目录检查。", &error))
    }
    // Reserve space for subsequent identity and warning fields before the first write.
    fn save_new_spectator_record(&self, record: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(record).map_err(|e| json_error("观战备份无法保存。", &e))?;
        if bytes.len() > 1024 * 1024 - 16384 { return Err("观战恢复记录过大，未应用观战配置。".into()); }
        atomic_write(&self.spectator_path(), &bytes)?;
        crate::cs2_spectator::startup_files(record, crate::cs2_spectator::StartupFiles::Apply)
    }
    /// Arm a bounded spectator-only transaction before a MulNX launch request.
    pub(crate) fn prepare_mulnx_observer(&self, video: &Path, executable: &Path, account: u32) -> Result<bool, String> {
        let guard = self.acquire_write_guard()?;
        if self.load()?.is_some() || self.spectator_pending() || self.full_spectator_pending() || self.playback_cleanup_pending() {
            return Err("请先完成上次游戏配置恢复。".into());
        }
        let mut record = crate::cs2_spectator::prepare_standalone(video, executable)?;
        record["mulnx"] = json!({"account":account,"executable":fs::canonicalize(executable).map_err(|e| io_error("游戏路径无法确认。", &e))?,"pid":null,"created":null,"finished":false,"optionsClean":false});
        self.save_new_spectator_record(&record)?;
        self.spectator_load_attempted_locked(&guard, true)?;
        Ok(true)
    }
    pub(crate) fn validate_unsubmitted_mulnx_observer(&self, video: &Path, executable: &Path, account: u32) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        let record = self.spectator_record()?.ok_or("观战备份缺失。")?;
        let saved_video = record["video"].as_str().ok_or("观战恢复目标缺失。")?;
        let saved_exe = record["mulnx"]["executable"].as_str().ok_or("观战程序路径缺失。")?;
        if record["loadAttempted"] != true || record["mulnx"]["account"] != json!(account)
            || !record["mulnx"]["pid"].is_null() || !record["mulnx"]["created"].is_null()
            || fs::canonicalize(saved_video).map_err(|e| io_error("观战目标无法确认。", &e))? != fs::canonicalize(video).map_err(|e| io_error("当前目标无法确认。", &e))?
            || fs::canonicalize(saved_exe).map_err(|e| io_error("观战程序无法确认。", &e))? != fs::canonicalize(executable).map_err(|e| io_error("当前程序无法确认。", &e))? {
            return Err("Steam 账号、游戏路径或观战启动身份已变化。".into());
        }
        self.validate_spectator_launch()?;
        let identity = if record["version"] == 3 { Some(record["hud"]["identity"].as_str().ok_or("HUD 键身份缺失。")?) } else { None };
        crate::cs2_spectator::validate_installed(executable, identity)
    }
    pub(crate) fn cancel_unsubmitted_mulnx_observer(&self) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        let record = self.spectator_record()?.ok_or("观战备份缺失。")?;
        if !record["mulnx"].is_object() || !record["mulnx"]["pid"].is_null() || !record["mulnx"]["created"].is_null() {
            return Err("游戏启动身份已确认，无法取消观战备份。".into());
        }
        self.spectator_load_attempted_locked(&guard, false)?;
        self.restore_spectator_locked(&guard)
    }
    pub(crate) fn mulnx_observer_unconfirmed(&self) -> Result<bool, String> {
        Ok(self.spectator_record()?.is_some_and(|record| record["mulnx"].is_object()
            && record["loadAttempted"] == true && record["mulnx"]["pid"].is_null() && record["mulnx"]["finished"] != true))
    }
    pub(crate) fn mark_mulnx_options_clean(&self) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        let mut record = self.spectator_record()?.ok_or("观战备份缺失。")?;
        if !record["mulnx"].is_object() { return Err("MulNX 观战记录缺失。".into()); }
        record["mulnx"]["optionsClean"] = json!(true);
        atomic_write(&self.spectator_path(), &serde_json::to_vec_pretty(&record).map_err(|e| json_error("观战状态无法保存。", &e))?)
    }
    pub(crate) fn bind_mulnx_observer(&self, pid: u32, created: u64, executable: &Path) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        let mut record = self.spectator_record()?.ok_or("观战备份缺失。")?;
        let actual = fs::canonicalize(executable).map_err(|e| io_error("游戏路径无法确认。", &e))?;
        if record["loadAttempted"] != true || record["mulnx"]["finished"] == true || record["mulnx"]["executable"] != json!(actual)
            || !record["mulnx"]["pid"].is_null() || !record["mulnx"]["created"].is_null() || pid == 0 || created == 0 {
            return Err("MulNX 观战启动身份无法确认。".into());
        }
        record["mulnx"]["pid"] = json!(pid); record["mulnx"]["created"] = json!(created);
        atomic_write(&self.spectator_path(), &serde_json::to_vec_pretty(&record).map_err(|e| json_error("观战身份无法保存。", &e))?)
    }
    pub(crate) fn mulnx_observer_matches(&self, pid: u32, created: u64, executable: &Path) -> Result<Option<bool>, String> {
        let Some(record) = self.spectator_record()? else { return Ok(None); };
        let actual = fs::canonicalize(executable).map_err(|e| io_error("游戏路径无法确认。", &e))?;
        if record["loadAttempted"] != true || record["mulnx"]["pid"] != json!(pid)
            || record["mulnx"]["created"] != json!(created) || record["mulnx"]["executable"] != json!(actual) {
            return Ok(None);
        }
        Ok(Some(record["version"] == 3))
    }
    pub(crate) fn mulnx_observer_native(&self) -> Result<bool, String> {
        Ok(self.spectator_record()?.is_some_and(|record| record["version"] == 3 && record["loadAttempted"] == true
            && record["mulnx"]["pid"].as_u64().is_some_and(|n| n > 0)
            && record["mulnx"]["created"].as_u64().is_some_and(|n| n > 0)))
    }
    pub(crate) fn mulnx_observer_target(&self) -> Result<Option<(PathBuf, PathBuf, u32)>, String> {
        let Some(record) = self.spectator_record()? else { return Ok(None); };
        if !record["mulnx"].is_object() { return Ok(None); }
        let video = record["video"].as_str().ok_or("观战恢复目标缺失。")?;
        let executable = record["mulnx"]["executable"].as_str().ok_or("观战恢复目标缺失。")?;
        let account = record["mulnx"]["account"].as_u64().and_then(|n| u32::try_from(n).ok()).ok_or("观战恢复账号缺失。")?;
        Ok(Some((video.into(), executable.into(), account)))
    }
    pub fn spectator_warning(&self) -> Option<String> {
        match self.spectator_record() {
            Ok(Some(record)) => record["warning"].as_str().map(str::to_string),
            Ok(None) => None,
            Err(error) => Some(error),
        }
    }
    pub fn validate_spectator_launch(&self) -> Result<(), String> {
        let record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if record["version"] != 2 && record["version"] != 3 {
            return Err("观战原绑定备份版本无法核实。".into());
        }
        let video = Path::new(record["video"].as_str().ok_or("观战恢复路径缺失。")?);
        crate::cs2_spectator::check_archive(video)?;
        crate::cs2_spectator::validate_bindings(video, &record["bindings"])?;
        if record["version"] == 3 { crate::cs2_spectator::validate_hud(video, &record["hud"])?; }
        crate::cs2_spectator::startup_files(&record, crate::cs2_spectator::StartupFiles::Validate)?;
        Ok(())
    }
    pub fn spectator_hud_identity(&self) -> Result<Option<String>, String> {
        let record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if record["version"] != 3 { return Ok(None); }
        let identity = record["hud"]["identity"].as_str().ok_or("HUD 键身份缺失。")?;
        crate::cs2_spectator::hud_cfg_name(identity)?;
        Ok(Some(identity.to_string()))
    }
    /// Persist the possible +exec write before submitting Steam's request.
    /// A definitively failed spawn can disarm it; an ambiguous launch cannot.
    pub fn spectator_load_attempted(&self, attempted: bool) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.spectator_load_attempted_locked(&guard, attempted)
    }
    fn spectator_load_attempted_locked(&self, _guard: &StoreGuard, attempted: bool) -> Result<(), String> {
        if attempted {
            self.validate_spectator_launch()?;
        }
        let mut record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if record["version"] != 2 && record["version"] != 3 {
            return Err("观战原绑定备份版本无法核实。".into());
        }
        record["loadAttempted"] = json!(attempted);
        atomic_write(
            &self.spectator_path(),
            &serde_json::to_vec_pretty(&record)
                .map_err(|e| json_error("观战加载记录无法保存。", &e))?,
        )
    }
    /// Same owner, separate durable optional-field record. No core transaction
    /// or settings gate depends on this file. Caller must confirm CS2 has exited.
    pub fn restore_spectator(&self) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.restore_spectator_locked(&guard)
    }
    fn restore_spectator_locked(&self, _guard: &StoreGuard) -> Result<(), String> {
        let Some(mut record) = self.spectator_record()? else {
            return Ok(());
        };
        let result = (|| {
            if record["version"] != 1 && record["version"] != 2 && record["version"] != 3 {
                return Err("观战恢复记录版本不支持。".into());
            }
            let video = Path::new(record["video"].as_str().ok_or("观战恢复路径缺失。")?);
            if !video.is_absolute() || video.file_name().is_none_or(|v| v != "cs2_video.txt") {
                return Err("观战恢复路径无效。".into());
            }
            // CFGs may already have been applied before Steam was submitted.
            crate::cs2_spectator::startup_files(&record, crate::cs2_spectator::StartupFiles::Restore)?;
            if record["version"] == 2 || record["version"] == 3 {
                match record["loadAttempted"].as_bool() {
                    Some(false) => {
                        return fs::remove_file(self.spectator_path())
                            .map_err(|e| io_error("未加载的观战备份记录未能清理，请重试。", &e))
                    }
                    Some(true) => (),
                    None => return Err("观战加载记录无法核实，原值备份仍保留。".into()),
                }
            }
            let bindings_result = if record["version"] == 3 {
                crate::cs2_spectator::restore_v3_bindings(video, &record["bindings"], &record["hud"])
            } else if record["version"] == 2 {
                crate::cs2_spectator::restore_bindings(video, &record["bindings"])
            } else {
                Ok(()) // Legacy records own only the spectator convar.
            };
            let convar_result = (|| {
                crate::cs2_spectator::check_archive(video)?;
                let original = record["original"].as_str().ok_or("观战原值备份缺失。")?;
                if original.len() > 256 * 1024 {
                    return Err("观战原值备份过大。".into());
                }
                let machine = video
                    .parent()
                    .ok_or("观战配置目录缺失。")?
                    .join("cs2_machine_convars.vcfg");
                let metadata = fs::symlink_metadata(&machine)
                    .map_err(|error| io_error("当前观战配置无法读取。", &error))?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > 256 * 1024
                {
                    return Err("当前观战配置无法安全核实。".into());
                }
                let current = fs::read_to_string(&machine)
                    .map_err(|error| io_error("当前观战配置无法读取。", &error))?;
                if current.len() > 256 * 1024 {
                    return Err("当前观战配置过大。".into());
                }
                let restored = if record["version"] == 1 {
                    crate::cs2_spectator::restore(original, &current)?
                } else {
                    crate::cs2_spectator::restore_with_applied(original, &current, false)?
                };
                if restored != current {
                    atomic_write(&machine, restored.as_bytes())?;
                }
                Ok::<(), String>(())
            })();
            let errors: Vec<_> = bindings_result
                .err()
                .into_iter()
                .chain(convar_result.err())
                .collect();
            if !errors.is_empty() {
                return Err(errors.join(" "));
            }
            fs::remove_file(self.spectator_path())
                .map_err(|error| io_error("观战原值已恢复，但记录未清理，请重试。", &error))
        })();
        if let Err(error) = result {
            let warning = format!("观战原值尚未恢复：{error} 帧率与画质恢复不受影响；退出游戏后可重试或打开备份目录检查。");
            record["warning"] = json!(warning);
            atomic_write(
                &self.spectator_path(),
                &serde_json::to_vec_pretty(&record)
                    .map_err(|error| json_error("观战恢复诊断无法保存。", &error))?,
            )
            .map_err(|error| format!("{warning} 恢复诊断未能更新，原值记录仍保留：{error}"))?;
            return Err(warning);
        }
        Ok(())
    }
    fn playback_cleanup_directory(&self) -> PathBuf {
        self.root.join("demo-playback-cleanup")
    }
    // Handoff ownership before clearing the core journal. Legacy journals are
    // supported too; if persistence fails, core restoration still proceeds and
    // the original journal remains the durable ownership evidence.
    fn preserve_playback_cleanup_locked(&self, _guard: &StoreGuard, value: &Value) -> Result<(), String> {
        if value.get("demoPlaybackCfg").is_none() {
            return Ok(());
        }
        let id = crate::demo_test::playback_cleanup_id(value)?;
        let path = self.playback_cleanup_directory().join(format!("{id}.json"));
        let journal = json!({"executable":value["executable"],
            "demoTestRequestId":value["demoTestRequestId"], "demoPlaybackCfg":value["demoPlaybackCfg"], "demoPlaybackCfgError":value["demoPlaybackCfgError"]});
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let previous = self.read_playback_cleanup(&path)?;
                if previous["journal"] != journal {
                    return Err("试播文件清理记录冲突，原记录仍保留。".into());
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(io_error("试播文件清理记录无法核实，原记录仍保留。", &error)),
        }
        let record = json!({"version":1,"journal":journal});
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&record)
                .map_err(|e| json_error("试播文件清理记录无法保存。", &e))?,
        )
    }
    fn read_playback_cleanup(&self, path: &Path) -> Result<Value, String> {
        let metadata =
            fs::symlink_metadata(path).map_err(|e| io_error("试播文件清理记录无法读取。", &e))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
            return Err("试播文件清理记录格式或大小异常，原记录仍保留。".into());
        }
        let record: Value = serde_json::from_slice(
            &fs::read(path).map_err(|e| io_error("试播文件清理记录无法读取。", &e))?,
        )
        .map_err(|e| json_error("试播文件清理记录无法解析。", &e))?;
        let id = crate::demo_test::playback_cleanup_id(&record["journal"])?;
        if record["version"] != 1
            || path.file_name() != Some(std::ffi::OsStr::new(&format!("{id}.json")))
        {
            return Err("试播文件清理记录身份无效，原记录仍保留。".into());
        }
        Ok(record)
    }
    pub fn playback_cleanup_pending(&self) -> bool {
        match fs::read_dir(self.playback_cleanup_directory()) {
            Ok(mut entries) => entries.next().is_some(),
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        }
    }
    /// Explicit retry only, after caller independently confirms no CS2 runs.
    pub fn restore_playback_cleanup(&self) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.restore_playback_cleanup_locked(&guard)
    }
    fn restore_playback_cleanup_locked(&self, _guard: &StoreGuard) -> Result<(), String> {
        let entries = match fs::read_dir(self.playback_cleanup_directory()) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io_error("试播文件清理目录无法读取。", &e)),
        };
        let mut errors = Vec::new();
        for (index, entry) in entries.enumerate() {
            if index >= 128 {
                errors.push("试播文件清理记录过多，请打开备份目录检查。".into());
                break;
            }
            let result = (|| {
                let path = entry
                    .map_err(|e| io_error("试播文件清理记录无法枚举。", &e))?
                    .path();
                let mut record = self.read_playback_cleanup(&path)?;
                if let Err(error) = crate::demo_test::cleanup_playback_cfg(&record["journal"]) {
                    record["warning"] = json!(error);
                    atomic_write(
                        &path,
                        &serde_json::to_vec_pretty(&record)
                            .map_err(|e| json_error("试播文件清理诊断无法保存。", &e))?,
                    )
                    .map_err(|e| format!("{error} 诊断未更新，原记录仍保留：{e}"))?;
                    return Err(error);
                }
                fs::remove_file(path)
                    .map_err(|e| io_error("试播文件已清理，清理记录仍待重试。", &e))
            })();
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "原画质和帧率恢复不受影响；试播文件清理待重试：{}",
                errors.join(" ")
            ))
        }
    }
    fn finish_core_restore_locked(
        &self,
        guard: &StoreGuard,
        handoff: Result<(), String>,
        spectator_error: Option<String>,
    ) -> Result<Option<String>, String> {
        let playback_error = match handoff {
            Ok(()) => {
                fs::remove_file(self.journal_path())
                    .map_err(|_| "原配置已恢复，但恢复记录尚未清理，请重试。".to_string())?;
                self.restore_playback_cleanup_locked(guard).err()
            }
            Err(error) => Some(format!(
                "原画质和帧率已恢复；清理证据转存失败，原启动记录仍保留：{error}"
            )),
        };
        let warnings: Vec<_> = spectator_error.into_iter().chain(playback_error).collect();
        Ok((!warnings.is_empty()).then(|| warnings.join(" ")))
    }
    pub fn preferences(&self) -> Result<Preferences, String> {
        match fs::read(self.root.join("preferences.json")) {
            Ok(bytes) => Preferences::from_json(
                &serde_json::from_slice::<Value>(&bytes).map_err(|_| "CS2 启动设置无法读取。")?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(Preferences::default())
            }
            Err(_) => Err("CS2 画质设置无法读取。".into()),
        }
    }
    fn full_optins(&self) -> Result<Value, String> {
        let path = self.root.join("full-spectator-optins.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({"version":1,"accounts":{}})),
            Err(_) => Err("完整解说键位选择无法读取。".into()),
            Ok(metadata) => {
                if !metadata.is_file() || metadata.len() > 64*1024 || crate::spectator_snapshot::check_path(&path, false).is_err() { return Err("完整解说键位选择无法安全读取。".into()); }
                let bytes = fs::read(&path).map_err(|_| "完整解说键位选择无法读取。")?;
                if bytes.len() > 64*1024 { return Err("完整解说键位选择过大。".into()); }
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| "完整解说键位选择损坏。")?;
                if value["version"] != 1 || value["accounts"].as_object().is_none_or(|v| v.len() > 128 || v.iter().any(|(k,v)| k.parse::<u32>().ok().filter(|n| *n != 0).is_none() || v != true)) {
                    return Err("完整解说键位选择损坏。".into());
                }
                Ok(value)
            }
        }
    }
    pub(crate) fn full_optin(&self, account: u32) -> Result<bool, String> {
        if account == 0 { return Err("Steam 账号无法确认。".into()); }
        Ok(self.full_optins()?["accounts"].get(account.to_string()).is_some())
    }
    pub(crate) fn set_full_optin(&self, account: u32, enabled: bool) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        if account == 0 { return Err("Steam 账号无法确认。".into()); }
        if self.load()?.is_some() { return Err("请结束制作后修改解说键位选择。".into()); }
        let mut value = self.full_optins()?;
        let accounts = value["accounts"].as_object_mut().ok_or("完整解说键位选择损坏。")?;
        if enabled { if accounts.len() >= 128 && !accounts.contains_key(&account.to_string()) { return Err("保存的账号选择过多。".into()); } accounts.insert(account.to_string(), json!(true)); }
        else { accounts.remove(&account.to_string()); }
        atomic_write(&self.root.join("full-spectator-optins.json"), &serde_json::to_vec(&value).map_err(|_| "完整解说键位选择无法保存。")?)
    }

    pub fn set_preferences(&self, preferences: Preferences) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.set_preferences_locked(&guard, preferences)
    }
    fn set_preferences_locked(&self, _guard: &StoreGuard, preferences: Preferences) -> Result<(), String> {
        if self.load()?.is_some() {
            return Err("请结束制作并恢复配置后再修改启动设置。".into());
        }
        atomic_write(
            &self.root.join("preferences.json"),
            &serde_json::to_vec(&preferences.json()).unwrap(),
        )
    }

    /// Save opaque source bytes before attempting any interpretation. These
    /// incident snapshots are never automatically restored over later settings.
    pub fn backup_originals(&self, video: &Path) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.backup_originals_locked(&guard, video)
    }
    fn backup_originals_locked(&self, _guard: &StoreGuard, video: &Path) -> Result<(), String> {
        if self.load()?.is_some() {
            return Err("上次 CS2 配置尚未恢复，请先退出游戏并重试恢复。".into());
        }
        let target = fs::canonicalize(video).map_err(|_| "无法核实备份目标。")?;
        let convars = video
            .parent()
            .ok_or("配置目录缺失。")?
            .join("cs2_machine_convars.vcfg");
        let snapshot = self.root.join(format!(
            "original-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "备份时间不可用。")?
                .as_nanos()
        ));
        fs::create_dir_all(&self.root).map_err(|_| "无法创建原始配置备份目录。")?;
        fs::create_dir(&snapshot).map_err(|_| "无法创建独立的原始配置备份。")?;
        let mut absent = Vec::new();
        for (path, limit) in [(video, 128 * 1024), (convars.as_path(), 256 * 1024)] {
            let metadata = match fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(error)
                    if path == convars
                        && error.kind() == std::io::ErrorKind::NotFound
                        && fs::symlink_metadata(path)
                            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    absent.push("cs2_machine_convars.vcfg");
                    continue;
                }
                Err(_) => return Err("无法读取原始配置大小或权限，未修改设置。".into()),
            };
            if metadata.len() > limit as u64 {
                return Err("原始游戏配置超过备份上限，未修改设置。".into());
            }
            let bytes = fs::read(path).map_err(|_| "无法备份原始游戏配置，未修改设置。")?;
            if bytes.len() > limit {
                return Err("原始游戏配置超过备份上限，未修改设置。".into());
            }
            atomic_write(
                &snapshot.join(path.file_name().ok_or("备份文件名缺失。")?),
                &bytes,
            )?;
        }
        atomic_write(
            &snapshot.join("absent.json"),
            &serde_json::to_vec(&absent).map_err(|_| "无法记录原始配置缺失状态。")?,
        )?;
        // Old snapshots have no target identity; never infer it from their name.
        if fs::canonicalize(video).map_err(|_| "无法复核备份目标。")? != target {
            return Err("备份期间配置目标发生变化，未修改设置。".into());
        }
        atomic_write(
            &snapshot.join("identity.json"),
            &serde_json::to_vec(&json!({"version": 1, "video": target}))
                .map_err(|_| "无法记录备份目标。")?,
        )?;
        Ok(())
    }
    /// The caller has shown a preview, confirmed its account and revalidated
    /// the same Steam identity and absence of a running game.
    pub fn import_selected_backup(&self, video: &Path, executable: &Path, backup: &str,
        original: &str, frame: Option<(&str, &str)>) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.import_selected_backup_locked(&guard, video, executable, backup, original, frame)
    }
    fn import_selected_backup_locked(&self, guard: &StoreGuard, video: &Path, executable: &Path, backup: &str,
        original: &str, frame: Option<(&str, &str)>) -> Result<(), String> {
        if self.spectator_pending() || self.playback_cleanup_pending() {
            return Err("请先完成上次观战或试播恢复。".into());
        }
        let restored = cs2_video::compatible_restore(backup, original)?;
        let machine = video.parent().ok_or("配置目录缺失。")?.join("cs2_machine_convars.vcfg");
        let mut files = vec![json!({"name":"cs2_video.txt", "original":original, "restored":restored, "backup":backup})];
        if let Some((before, selected)) = frame {
            let after = cs2_frame_rate::compatible_restore(selected, before)?;
            files.push(json!({"name":"cs2_machine_convars.vcfg", "original":before, "restored":after, "backup":selected}));
            unchanged(&machine, before.as_bytes())?;
        }
        unchanged(video, original.as_bytes())?;
        self.backup_originals_locked(guard, video)?;
        // All original bytes are durable before the forward-recovery journal.
        let record = json!({"version":4,"video":fs::canonicalize(video).map_err(|e| io_error("配置目标无法确认。", &e))?,
            "executable":executable,"launchAttempted":false,"files":files});
        self.save_locked(guard, &record)?;
        self.restore_selected_backup_locked(guard, &record)
    }
    fn restore_selected_backup_locked(&self, _guard: &StoreGuard, record: &Value) -> Result<(), String> {
        let video = Path::new(record["video"].as_str().ok_or("恢复目标缺失。")?);
        if !video.is_absolute() || video.file_name().is_none_or(|n| n != "cs2_video.txt")
            || fs::canonicalize(video).map_err(|e| io_error("恢复目标无法确认。", &e))? != video {
            return Err("恢复目标发生变化，原件与记录仍保留。".into());
        }
        let entries = record["files"].as_array().ok_or("恢复记录损坏。")?;
        if !(1..=2).contains(&entries.len()) { return Err("恢复文件范围无效。".into()); }
        let mut plan = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let name = if index == 0 { "cs2_video.txt" } else { "cs2_machine_convars.vcfg" };
            if entry["name"] != name { return Err("恢复文件范围无效。".into()); }
            let original = entry["original"].as_str().ok_or("恢复原件缺失。")?;
            let restored = entry["restored"].as_str().ok_or("恢复内容缺失。")?;
            let backup = entry["backup"].as_str().ok_or("所选备份缺失。")?;
            if [original,restored,backup].iter().any(|v| v.len() > 256*1024) { return Err("恢复记录过大。".into()); }
            let expected = if index == 0 { cs2_video::compatible_restore(backup, original)? }
                else { cs2_frame_rate::compatible_restore(backup, original)? };
            if expected != restored { return Err("恢复记录与字段范围不一致。".into()); }
            let path = video.with_file_name(name);
            let metadata = fs::symlink_metadata(&path).map_err(|e| io_error("恢复文件无法读取。", &e))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256*1024 {
                return Err("恢复文件类型或大小发生变化。".into());
            }
            let current = fs::read(&path).map_err(|e| io_error("恢复文件无法读取。", &e))?;
            if current != original.as_bytes() && current != restored.as_bytes() { return Err("配置已被其他程序修改，请检查后重试；原件仍保留。".into()); }
            plan.push((path,current,restored));
        }
        // Validate every file before the first write; interrupted imports resume
        // idempotently and never overwrite new external bytes on retry.
        for (path, current, _) in &plan { unchanged(path,current)?; }
        for (path,current,restored) in plan {
            unchanged(&path,&current)?;
            if current != restored.as_bytes() { atomic_write(&path,restored.as_bytes())?; }
        }
        atomic_write(&self.root.join("last-selected-recovery.json"), &serde_json::to_vec_pretty(record).map_err(|_| "恢复记录无法保存。")?)?;
        fs::remove_file(self.journal_path()).map_err(|e| io_error("设置已恢复，记录清理失败，请重试。",&e))
    }
    pub fn prepare_preserved(&self, video: &Path, executable: &Path) -> Result<Value, String> {
        let guard = self.acquire_write_guard()?;
        self.prepare_preserved_locked(&guard, video, executable)
    }
    fn prepare_preserved_locked(&self, guard: &StoreGuard, video: &Path, executable: &Path) -> Result<Value, String> {
        if self.mulnx_observer_target()?.is_some() { return Err("请先恢复上次 MulNX 观战键位。".into()); }
        self.backup_originals_locked(guard, video)?;
        let mut value = json!({"version":3,"preserveSettings":true,"video":video,"executable":executable,
            "launchAttempted":false,"pid":null,"created":null});
        let spectator = if self.spectator_pending() || self.full_spectator_pending() {
            Err("上次观战键位尚未恢复，本次未加载观战 CFG。".into())
        } else {
            crate::cs2_spectator::prepare_standalone(video, executable)
        };
        match spectator {
            Ok(record) => {
                // A failed or partial CFG write must never fall through to launch.
                self.save_new_spectator_record(&record)?;
                value["spectatorCfg"] = json!(true); value["nativeHudToggle"] = json!(record["version"] == 3);
                if record["version"] == 3 { value["hudIdentity"] = record["hud"]["identity"].clone(); }
                if let Some(warning) = record["hudWarning"].as_str() { value["spectatorWarning"] = json!(warning); }
            }
            Err(warning) => value["spectatorWarning"] = json!(warning),
        }
        self.save_locked(guard, &value)?;
        Ok(value)
    }
    pub fn prepare_with_frame_rate(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        let guard = self.acquire_write_guard()?;
        self.prepare_with_frame_rate_locked(&guard, video, executable, size)
    }
    fn prepare_with_frame_rate_locked(
        &self,
        guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        self.backup_originals_locked(guard, video)?;
        self.prepare_backed_up_locked(guard, video, executable, size)
    }
    pub fn prepare_backed_up(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        let guard = self.acquire_write_guard()?;
        self.prepare_backed_up_locked(&guard, video, executable, size)
    }
    fn prepare_backed_up_locked(
        &self,
        guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        if self.mulnx_observer_target()?.is_some() { return Err("请先恢复上次 MulNX 观战键位。".into()); }
        let preferences = self.preferences()?;
        let frames = cs2_frame_rate::prepare(video, executable, preferences.frame_rate_limit)?;
        let spectator = if self.spectator_pending() || self.full_spectator_pending() {
            Err("上次观战字段或键位尚未恢复，本次未加载观战 CFG；可退出游戏后重试恢复。".into())
        } else {
            crate::cs2_spectator::prepare(&frames, video, executable)
        };
        let frames = if spectator.is_ok() {
            cs2_frame_rate::prepare_with_observer(video, executable, preferences.frame_rate_limit, true)?
        } else { frames };
        if let Ok(record) = &spectator {
            // Save key originals before any startup CFG can execute our bindings.
            self.save_new_spectator_record(record)?;
        }
        let mut journal = self.prepare_files_locked(guard, video, executable, size, Some(frames))?;
        match spectator {
            Ok(_) => {
                journal["spectatorCfg"] = json!(true);
                let record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
                journal["nativeHudToggle"] = json!(record["version"] == 3);
                if record["version"] == 3 { journal["hudIdentity"] = record["hud"]["identity"].clone(); }
                if let Some(warning) = record["hudWarning"].as_str() { journal["spectatorWarning"] = json!(warning); }
            },
            Err(warning) => {
                journal["spectatorWarning"] = json!(format!("数字键观战预设未应用：{warning}"))
            }
        }
        self.save_locked(guard, &journal)?;
        Ok(journal)
    }
    fn prepare_files_locked(
        &self,
        guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
        frames: Option<Vec<Value>>,
    ) -> Result<Value, String> {
        let plan = self.plan_files(video, executable, size, frames)?;
        self.commit_files_locked(guard, &plan, atomic_write)?;
        Ok(plan)
    }

    /// Construct a plan from current files without creating a journal or writing configuration.
    fn plan_files(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
        frames: Option<Vec<Value>>,
    ) -> Result<Value, String> {
        if self.load()?.is_some() {
            return Err("上次 CS2 配置尚未恢复，请先退出游戏并重试恢复。".into());
        }
        let bytes =
            fs::read(video).map_err(|_| "未找到当前 Steam 账号的视频配置，请先运行一次 CS2。")?;
        if bytes.len() > 128 * 1024 {
            return Err("CS2 视频配置过大，未修改游戏设置。".into());
        }
        let original =
            String::from_utf8(bytes).map_err(|_| "视频配置编码不支持，未修改游戏设置。")?;
        let preferences = self.preferences()?;
        let owned = cs2_video::sized_quality_preset(preferences.quality, size);
        let applied = cs2_video::apply(&original, &owned)?;
        let mut value = json!({"version":1,"video":video,"executable":executable,"original":original,"applied":applied,"owned":owned,"launchAttempted":false,"pid":null,"created":null});
        if let Some(frames) = frames {
            value["version"] = json!(2);
            value["frameRateLimit"] = json!(preferences.frame_rate_limit);
            value["frameRateFiles"] = json!(frames);
        }
        // Validate frame paths and scope while constructing the plan.
        frame_files(&value, video, executable)?;
        Ok(value)
    }

    /// Annotate an independently constructed plan; callers still own identity verification.
    fn plan_files_for_session(&self, video: &Path, executable: &Path, size: cs2_video::VideoSize, frames: Option<Vec<Value>>, session: &crate::cs2_config_identity::SessionIdentity) -> Result<Value, String> {
        if fs::canonicalize(video).map_err(|_| "identity_invalid")? != session.config.video
            || fs::canonicalize(executable).map_err(|_| "identity_invalid")? != session.config.executable {
            return Err("identity_changed".into());
        }
        let mut plan = self.plan_files(video, executable, size, frames)?;
        session.write(&mut plan).map_err(str::to_string)?;
        Ok(plan)
    }

    /// Prepare both owners under the same Store guard. The Host must have
    /// independently verified the Steam account and confirmed CS2 is stopped.
    pub(crate) fn prepare_coordinated(
        &self, video: &Path, executable: &Path, size: cs2_video::VideoSize,
        frames: Option<Vec<Value>>, session: &crate::cs2_config_identity::SessionIdentity,
        owned: &std::collections::BTreeSet<crate::spectator_recovery_plan::Input>,
        applied: &crate::spectator_recovery_plan::Bindings, candidate: &str,
    ) -> Result<Value, String> {
        let guard = self.acquire_write_guard()?;
        self.prepare_coordinated_locked(&guard, video, executable, size, frames, session, owned, applied, candidate, atomic_write, None, None)
    }

    /// Commit a source-bound, explicitly selected full configuration.
    pub(crate) fn prepare_eligible(
        &self, video: &Path, executable: &Path, size: cs2_video::VideoSize,
        session_id: &str, fingerprint: &crate::spectator_eligibility::Fingerprint,
        attachments: &Value,
    ) -> Result<Value, String> {
        self.prepare_eligible_with_writer(video, executable, size, session_id, fingerprint, attachments, atomic_write)
    }
    pub(crate) fn prepare_eligible_with_writer(
        &self, video: &Path, executable: &Path, size: cs2_video::VideoSize,
        session_id: &str, fingerprint: &crate::spectator_eligibility::Fingerprint,
        attachments: &Value, write: fn(&Path, &[u8]) -> Result<(), String>,
    ) -> Result<Value, String> {
        let guard = self.acquire_write_guard()?;
        let eligible = crate::spectator_eligibility::revalidate(fingerprint, video, executable, fingerprint.identity.account)
            .map_err(|e| e.message().to_string())?;
        let original = fs::read_to_string(&fingerprint.identity.keys).map_err(|_| "键位配置无法读取，使用基础观战模式。")?;
        let (owned, applied, candidate) = crate::spectator_eligibility::build_plan(&eligible, &original)
            .map_err(|e| e.message().to_string())?;
        let preferences = self.preferences()?;
        let frames = cs2_frame_rate::prepare(video, executable, preferences.frame_rate_limit)?;
        crate::cs2_spectator::full_mode_convar_compatible(&frames, video)?;
        let session = crate::cs2_config_identity::SessionIdentity { session_id:session_id.into(), config:fingerprint.identity.clone() };
        self.prepare_coordinated_locked(&guard, video, executable, size, Some(frames), &session,
            &owned, &applied, &candidate, write, Some(fingerprint), Some(attachments))
    }

    /// Recheck frozen source and expected applied bytes before submitting Steam.
    pub(crate) fn validate_full_launch(&self, fingerprint: &crate::spectator_eligibility::Fingerprint) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        let core = self.load()?.ok_or("完整解说键位记录缺失。")?;
        let session = crate::cs2_config_identity::SessionIdentity::read(&core).map_err(str::to_string)?.ok_or("完整解说键位身份缺失。")?;
        if core["fullSnapshot"] != true || core["configWriteAttempted"] != true || session.config != fingerprint.identity
            || crate::spectator_snapshot::linked_session(&self.root)?.as_ref() != Some(&session) {
            return Err("完整解说键位身份已变化，请恢复后重试。".into());
        }
        let video = Path::new(core["video"].as_str().ok_or("完整解说键位路径缺失。")?);
        let exe = Path::new(core["executable"].as_str().ok_or("完整解说键位路径缺失。")?);
        let applied = core["fullAppliedSha256"].as_str().ok_or("完整解说键位摘要缺失。")?;
        let frames = frame_files(&core, video, exe)?;
        unchanged(video, core["applied"].as_str().ok_or("完整解说键位记录损坏。")?.as_bytes())?;
        for (path, _, next) in &frames { unchanged(path, next.as_bytes())?; }
        crate::spectator_eligibility::verify_for_launch(fingerprint, applied, video, exe, session.config.account, &frames)
            .map_err(|e| e.message().to_string())
    }

    fn prepare_coordinated_locked(
        &self, guard: &StoreGuard, video: &Path, executable: &Path, size: cs2_video::VideoSize,
        frames: Option<Vec<Value>>, session: &crate::cs2_config_identity::SessionIdentity,
        owned: &std::collections::BTreeSet<crate::spectator_recovery_plan::Input>,
        applied: &crate::spectator_recovery_plan::Bindings, candidate: &str,
        write: fn(&Path, &[u8]) -> Result<(), String>,
        eligibility: Option<&crate::spectator_eligibility::Fingerprint>,
        attachments: Option<&Value>,
    ) -> Result<Value, String> {
        if self.load()?.is_some() || self.spectator_pending() || self.full_spectator_pending() {
            return Err("snapshot_pending".into());
        }
        let mut core = self.plan_files_for_session(video, executable, size, frames, session)?;
        if let Some(attachment) = attachments {
            let object = attachment.as_object().ok_or("invalid_plan")?;
            if object.keys().any(|key| !["consoleDiagnostics", "consoleDiagnosticsWarning"].contains(&key.as_str())) { return Err("invalid_plan".into()); }
            for (key, value) in object { core[key] = value.clone(); }
        }
        if let Some(fingerprint) = eligibility {
            if fingerprint.identity != session.config { return Err("identity_changed".into()); }
            crate::spectator_eligibility::revalidate(fingerprint, video, executable, session.config.account).map_err(|e| e.message().to_string())?;
            core["fullSource"] = json!({"sha256":fingerprint.default_sha256,"source":fingerprint.source});
        }
        let (key, original_keys, applied_keys) = crate::spectator_snapshot::plan_application(
            video, executable, session.config.account, session, owned, applied, candidate)?;
        if eligibility.is_some() {
            use sha2::{Digest, Sha256};
            core["fullAppliedSha256"] = json!(format!("{:x}", Sha256::digest(&applied_keys)));
        }
        let key_identity = fs::canonicalize(&key).map_err(|_| "identity_invalid")?;
        if key_identity != session.config.keys || fs::canonicalize(video).map_err(|_| "identity_invalid")? == key_identity {
            return Err("scope_overlap".into());
        }
        for (path, _, _) in frame_files(&core, video, executable)? {
            if fs::canonicalize(path).map_err(|_| "identity_invalid")? == key_identity {
                return Err("scope_overlap".into());
            }
        }
        self.preflight_core_plan(&core)?;
        crate::spectator_snapshot::capture_coordinated(&self.root, video, executable,
            session.config.account, owned, applied, write, session)?;
        crate::spectator_snapshot::verify_prepared(&self.root, video, executable,
            session.config.account, session, owned, applied, &original_keys, false)?;
        core["fullSnapshot"] = json!(true);
        core["configWriteAttempted"] = json!(false);
        self.save_coordinated_locked(guard, &core, write)?;
        // Both records independently say a write may occur before either owner writes.
        crate::spectator_snapshot::mark_coordinated_write(&self.root, video, executable,
            session.config.account, session, owned, applied, &original_keys, write)?;
        core["configWriteAttempted"] = json!(true);
        self.save_coordinated_locked(guard, &core, write)?;
        self.preflight_core_plan(&core)?;
        crate::spectator_snapshot::verify_prepared(&self.root, video, executable,
            session.config.account, session, owned, applied, &original_keys, true)?;
        if let Some(fingerprint) = eligibility {
            crate::spectator_eligibility::revalidate(fingerprint, video, executable, session.config.account).map_err(|e| e.message().to_string())?;
        }
        let applied_video = core["applied"].as_str().ok_or("invalid_plan")?;
        write(video, applied_video.as_bytes())?;
        unchanged(video, applied_video.as_bytes())?;
        for (path, original, next) in frame_files(&core, video, executable)? {
            unchanged(path, original.as_bytes())?;
            write(path, next.as_bytes())?;
            unchanged(path, next.as_bytes())?;
        }
        crate::spectator_snapshot::verify_prepared(&self.root, video, executable,
            session.config.account, session, owned, applied, &original_keys, true)?;
        if let Some(fingerprint) = eligibility {
            let frames = frame_files(&core, video, executable)?;
            crate::spectator_eligibility::revalidate_after_core(fingerprint, video, executable, session.config.account, &frames).map_err(|e| e.message().to_string())?;
        }
        if applied_keys != original_keys { write(&key, &applied_keys)?; }
        crate::spectator_snapshot::verify_applied(video, executable, session.config.account, session, &applied_keys)?;
        Ok(core)
    }

    fn save_coordinated_locked(&self, _guard: &StoreGuard, value: &Value,
        write: fn(&Path, &[u8]) -> Result<(), String>) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "invalid_plan")?;
        if bytes.len() > 4 * 1024 * 1024 { return Err("invalid_plan".into()); }
        write(&self.journal_path(), &bytes)?;
        if fs::read(self.journal_path()).map_err(|_| "journal_readback_failed")? != bytes
            || self.load()?.as_ref() != Some(value) { return Err("journal_readback_failed".into()); }
        Ok(())
    }

    fn preflight_core_plan(&self, value: &Value) -> Result<(), String> {
        let video = Path::new(value["video"].as_str().ok_or("invalid_plan")?);
        let executable = Path::new(value["executable"].as_str().ok_or("invalid_plan")?);
        let original = value["original"].as_str().ok_or("invalid_plan")?;
        unchanged(video, original.as_bytes())?;
        for (path, original, _) in frame_files(value, video, executable)? {
            unchanged(path, original.as_bytes())?;
        }
        Ok(())
    }

    /// Recheck every original, then durably save the plan before the first write.

    fn commit_files_locked(
        &self,
        guard: &StoreGuard,
        value: &Value,
        write_config: fn(&Path, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.load()?.is_some() {
            return Err("上次 CS2 配置尚未恢复，请先退出游戏并重试恢复。".into());
        }
        let video = Path::new(value["video"].as_str().ok_or("CS2 配置路径缺失。")?);
        let executable = Path::new(value["executable"].as_str().ok_or("CS2 程序路径缺失。")?);
        let original = value["original"].as_str().ok_or("CS2 原配置备份缺失。")?;
        let applied = value["applied"].as_str().ok_or("CS2 应用记录缺失。")?;
        let frame_files = frame_files(value, video, executable)?;
        // Preflight every file before writing the durable journal or any config.
        for (path, original, _) in &frame_files {
            if fs::read_to_string(path).map_err(|_| "无法读取启动配置。")? != *original {
                return Err("启动配置在准备期间发生变化，请重试。".into());
            }
        }
        if fs::read(video).map_err(|_| "无法读取视频配置，原始备份仍保留。")? != original.as_bytes()
        {
            return Err("视频配置在准备期间发生变化，未修改配置。".into());
        }
        // The original is durable and read-back verified before touching the game.
        self.save_locked(guard, value)?;
        write_config(video, applied.as_bytes())?;
        for (path, original, applied) in frame_files {
            if fs::read_to_string(path).map_err(|_| "无法读取启动配置，备份仍保留。")? != original
            {
                return Err("启动配置在应用期间发生变化，备份仍保留。".into());
            }
            write_config(path, applied.as_bytes())?;
        }
        Ok(())
    }
    /// Host must rediscover this account and confirm all CS2 processes have exited.
    pub(crate) fn restore_coordinated(&self, video: &Path, executable: &Path, account: u32) -> Result<Option<String>, String> {
        let guard = self.acquire_write_guard()?;
        if let Some(core) = self.load()? {
            if core["fullSnapshot"] != true || unconfirmed_launch(&core) { return Err("coordinated_recovery_required".into()); }
            crate::spectator_snapshot::handoff(&self.root, video, executable, account, &core, atomic_write)?;
            if crate::spectator_snapshot::handed_off_unwritten(&self.root, &core)? {
                let playback = self.preserve_playback_cleanup_locked(&guard, &core);
                if let Some(warning) = self.finish_core_restore_locked(&guard, playback, None)? { return Ok(Some(warning)); }
                if !crate::spectator_snapshot::finish_unwritten_preparation(&self.root, video, executable, account, atomic_write)? { return Err("snapshot_changed".into()); }
                return Ok(None);
            }
            if let Some(warning) = self.restore_core_locked(&guard, true)? { return Ok(Some(warning)); }
        } else if !self.full_spectator_pending() {
            return Ok(None);
        } else if !crate::spectator_snapshot::has_terminal(&self.root)? {
            return Err("coordinated_recovery_required".into());
        }
        if crate::spectator_snapshot::finish_unwritten_preparation(&self.root, video, executable, account, atomic_write)? { return Ok(None); }
        match crate::spectator_snapshot::recover(&self.root, video, executable, account, atomic_write) {
            Ok(()) => Ok(None),
            Err(error) => Ok(Some(full_recovery_warning(&error).into())),
        }
    }

    fn restore_core_spectator_locked(&self, guard: &StoreGuard) -> Option<String> {
        match self.mulnx_observer_target() {
            Ok(Some(_)) => Some("MulNX 观战备份仍待按原账号和程序恢复。".into()),
            Err(error) => Some(error),
            Ok(None) => self.restore_spectator_locked(guard).err(),
        }
    }

    /// Caller must independently confirm no CS2 process can still write this file.
    pub fn restore(&self) -> Result<Option<String>, String> {
        let guard = self.acquire_write_guard()?;
        self.restore_core_locked(&guard, false)
    }
    fn restore_core_locked(&self, guard: &StoreGuard, handoff_complete: bool) -> Result<Option<String>, String> {
        let Some(value) = self.load()? else {
            return Ok(None);
        };
        if unconfirmed_launch(&value) {
            return Err("Steam 启动结果待确认，恢复记录与备份仍保留。".into());
        }
        if value["fullSnapshot"] == true && !handoff_complete {
            return Err("coordinated_recovery_required".into());
        }
        if value["version"] == 4 { self.restore_selected_backup_locked(guard, &value)?; return Ok(None); }
        let playback_handoff = self.preserve_playback_cleanup_locked(guard, &value);
        if value["version"] == 3 {
            if value["preserveSettings"] != true
                || [
                    "original",
                    "applied",
                    "owned",
                    "frameRateFiles",
                    "frameRateLimit",
                ]
                .iter()
                .any(|key| value.get(*key).is_some())
                || !value["video"].as_str().is_some_and(|v| {
                    Path::new(v).is_absolute()
                        && Path::new(v)
                            .file_name()
                            .is_some_and(|n| n == "cs2_video.txt")
                })
                || !value["executable"]
                    .as_str()
                    .is_some_and(|v| Path::new(v).is_absolute())
            {
                return Err("保留设置的启动记录无效。".into());
            }
            // Video and frame settings remain untouched; spectator keys are an
            // independent bounded owner and may still need restoration.
            let spectator_error = self.restore_core_spectator_locked(guard);
            return self.finish_core_restore_locked(guard, playback_handoff, spectator_error);
        }
        let path = Path::new(value["video"].as_str().ok_or("CS2 恢复路径缺失。")?);
        if path.file_name().and_then(|n| n.to_str()) != Some("cs2_video.txt") || !path.is_absolute()
        {
            return Err("CS2 恢复路径无效。".into());
        }
        let original = value["original"].as_str().ok_or("CS2 原配置备份缺失。")?;
        let applied = value["applied"].as_str().ok_or("CS2 应用记录缺失。")?;
        let owned: BTreeMap<String, String> =
            serde_json::from_value(value["owned"].clone()).map_err(|_| "CS2 字段恢复记录损坏。")?;
        if !cs2_video::supported_preset(&owned) {
            return Err("CS2 字段恢复记录不支持。".into());
        }
        if cs2_video::apply(original, &owned)? != applied {
            return Err("CS2 原配置与应用记录不一致，备份仍保留。".into());
        }
        let executable = Path::new(value["executable"].as_str().ok_or("CS2 程序路径缺失。")?);
        let frames = frame_files(&value, path, executable)?;
        let mut frame_restorations = Vec::new();
        for (index, (frame_path, _, _)) in frames.iter().enumerate() {
            let current =
                fs::read_to_string(frame_path).map_err(|_| "无法读取帧率配置，备份仍保留。")?;
            if current.len() > 256 * 1024 {
                return Err("当前帧率配置过大，备份仍保留。".into());
            }
            frame_restorations.push((
                *frame_path,
                current.clone(),
                cs2_frame_rate::restored(&value["frameRateFiles"][index], &current)?,
            ));
        }
        let current =
            fs::read_to_string(path).map_err(|_| "无法读取游戏视频配置；原配置备份仍保留。")?;
        let restored = if current == original {
            current.clone()
        } else {
            cs2_video::restore(original, applied, &current, &owned)?
        };
        // Recheck all inputs before the first write, and each file immediately
        // before replacement. A later conflict retains the journal for retry.
        for (frame_path, expected, _) in &frame_restorations {
            unchanged(frame_path, expected.as_bytes())?;
        }
        unchanged(path, current.as_bytes())?;
        if restored != current {
            atomic_write(path, restored.as_bytes())?;
        }
        for (frame_path, expected, restored) in frame_restorations {
            unchanged(frame_path, expected.as_bytes())?;
            if restored != expected {
                atomic_write(frame_path, restored.as_bytes())?;
            }
        }
        // Keep a readable, exact original even after successful recovery.
        atomic_write(&self.root.join("last-original.txt"), original.as_bytes())?;
        if value["version"] == 2 {
            atomic_write(
                &self.root.join("last-frame-rate-backup.json"),
                &serde_json::to_vec_pretty(&value["frameRateFiles"])
                    .map_err(|_| "帧率备份无法保存。")?,
            )?;
        }
        // Optional errors retain their own original + diagnostic and cannot
        // prevent completion of the existing FPS/video transaction.
        let spectator_error = self.restore_core_spectator_locked(guard);
        self.finish_core_restore_locked(guard, playback_handoff, spectator_error)
    }
}

fn unchanged(path: &Path, expected: &[u8]) -> Result<(), String> {
    if fs::read(path).map_err(|_| "无法复核当前配置，备份仍保留。")? != expected {
        return Err("配置已被游戏或其他程序修改，请重新检查；备份仍保留。".into());
    }
    Ok(())
}

fn frame_files<'a>(
    value: &'a Value,
    video: &Path,
    executable: &Path,
) -> Result<Vec<(&'a Path, &'a str, &'a str)>, String> {
    if value["version"] == 1 {
        return Ok(Vec::new());
    }
    let limit = value["frameRateLimit"]
        .as_u64()
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| [0, 30, 60].contains(v))
        .ok_or("帧率恢复选项无效。")?;
    let records = value["frameRateFiles"]
        .as_array()
        .ok_or("帧率恢复记录缺失。")?;
    if records.is_empty() || records.len() > 33 || records[0]["kind"] != "convars" {
        return Err("帧率恢复记录无效。".into());
    }
    let mut unique = std::collections::BTreeSet::new();
    records
        .iter()
        .map(|record| {
            let validated = cs2_frame_rate::validated(record, video, executable, limit)?;
            if !unique.insert(validated.0.to_string_lossy().to_lowercase()) {
                return Err("帧率恢复路径重复。".into());
            }
            Ok(validated)
        })
        .collect()
}
