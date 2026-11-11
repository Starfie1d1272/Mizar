//! Durable physical configuration transaction; production state remains in Companion.
use crate::cs2_session_record::{GsiSource, SessionRecord};
use crate::cs2_video;
use crate::{cs2_frame_rate, cs2_preferences::Preferences};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn full_recovery_warning(code: &str) -> &'static str {
    match code {
        "conflict" => "观战键位已被其他程序修改，保留当前配置和原备份；请核对后重试。",
        "identity_changed" | "identity_invalid" | "identity" | "path_invalid" => {
            "无法确认原账号或安装位置，观战键位备份仍保留。"
        }
        "damaged" | "snapshot_invalid" | "snapshot_file_invalid" | "snapshot_changed" => {
            "观战键位备份校验失败，原备份仍保留。"
        }
        _ => "暂时无法恢复观战键位，原备份仍保留；请检查文件访问后重试。",
    }
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

fn read_config_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| io_error("无法读取原始游戏配置。", &e))?;
    if !file
        .metadata()
        .map_err(|e| io_error("无法核实配置文件。", &e))?
        .is_file()
    {
        return Err("原始游戏配置不是普通文件。".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error("无法读取原始游戏配置。", &e))?;
    if bytes.len() > limit {
        return Err("原始游戏配置超过读取上限，未修改设置。".into());
    }
    Ok(bytes)
}

fn original_files(video: &Path) -> Result<Vec<(PathBuf, Option<Vec<u8>>)>, String> {
    let convars = video
        .parent()
        .ok_or("配置目录缺失。")?
        .join("cs2_machine_convars.vcfg");
    let mut files = Vec::new();
    for (path, limit) in [(video, 128 * 1024), (convars.as_path(), 256 * 1024)] {
        if path == convars
            && fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            files.push((path.to_path_buf(), None));
        } else {
            files.push((path.to_path_buf(), Some(read_config_bytes(path, limit)?)));
        }
    }
    Ok(files)
}

struct StoreGuard {
    _file: fs::File,
}

pub struct SessionStore {
    root: PathBuf,
}
impl SessionStore {
    pub(crate) fn pending_source_retire(&self) -> Result<Option<Value>, String> {
        match fs::read(self.root.join("gsi-source-retire.json")) {
            Ok(bytes) if bytes.len() <= 4096 => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "受管来源退出记录无效。".into()),
            Ok(_) => Err("受管来源退出记录无效。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("受管来源退出记录不可读。".into()),
        }
    }

    pub(crate) fn remember_source_retire(&self, record: &Value) -> Result<(), String> {
        if let Some(previous) = self.pending_source_retire()? {
            if previous["sourceId"] != record["sourceId"] {
                return Err("已有其他受管来源退出待处理。".into());
            }
            if previous["ticket"].is_string() {
                if record["ticket"].is_null() {
                    return Ok(());
                }
                if previous["ticket"] != record["ticket"]
                    && previous["runtimeInstanceId"] == record["runtimeInstanceId"]
                {
                    return Err("受管来源退出资格已变化。".into());
                }
            }
        }
        atomic_write(
            &self.root.join("gsi-source-retire.json"),
            &serde_json::to_vec(record).map_err(|_| "受管来源退出记录无法保存。")?,
        )
    }

    pub(crate) fn clear_source_retire(&self) -> Result<(), String> {
        match fs::remove_file(self.root.join("gsi-source-retire.json")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("受管来源退出记录无法移除。".into()),
        }
    }

    fn validate_gsi_token(&self, installation: &Value) -> Result<(), String> {
        let token = installation["gsiToken"]
            .as_str()
            .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("GSI 安装记录无效。")?;
        if installation["schemaVersion"] != 1 {
            return Err("GSI 安装记录无效。".into());
        }
        let path = self
            .root
            .parent()
            .ok_or("来源配置路径无效。")?
            .join("gsi-token.txt");
        let recorded = fs::read(&path).map_err(|_| "GSI 安装记录不可用。")?;
        if recorded.len() > 256 || std::str::from_utf8(&recorded).ok().map(str::trim) != Some(token)
        {
            return Err("GSI 安装记录不一致。".into());
        }
        Ok(())
    }

    /// Only a missing installation record and a missing owned sender together
    /// establish that this installation has no managed GSI configuration.
    pub(crate) fn gsi_is_uninstalled(&self, journal: &SessionRecord) -> Result<bool, String> {
        fn missing(path: &Path) -> Result<bool, String> {
            match fs::symlink_metadata(path) {
                Ok(_) => Ok(false),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
                Err(_) => Err("GSI 配置状态不可读取。".into()),
            }
        }
        let executable = Path::new(&journal.executable);
        let game = executable.ancestors().nth(3).ok_or("游戏路径无效。")?;
        fs::canonicalize(game).map_err(|_| "游戏安装位置无法确认。")?;
        let state = self
            .root
            .parent()
            .ok_or("来源配置路径无效。")?
            .join("gsi-install/install.json");
        let sender = game.join("csgo/cfg/gamestate_integration_mizar.cfg");
        Ok(missing(&state)? && missing(&sender)?)
    }

    pub(crate) fn pending_source_cancel(&self) -> Result<Option<Value>, String> {
        match fs::read(self.root.join("gsi-source-cancel.json")) {
            Ok(bytes) if bytes.len() <= 4096 => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "受管来源清理记录无效。".into()),
            Ok(_) => Err("受管来源清理记录无效。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("受管来源清理记录不可读。".into()),
        }
    }

    pub(crate) fn remember_source_cancel(&self, request: &Value) -> Result<(), String> {
        if let Some(previous) = self.pending_source_cancel()? {
            if previous != *request {
                return Err("已有受管来源清理待处理。".into());
            }
            return Ok(());
        }
        atomic_write(
            &self.root.join("gsi-source-cancel.json"),
            &serde_json::to_vec(request).map_err(|_| "受管来源清理记录无法保存。")?,
        )
    }

    pub(crate) fn clear_source_cancel(&self) -> Result<(), String> {
        match fs::remove_file(self.root.join("gsi-source-cancel.json")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("受管来源清理记录无法移除。".into()),
        }
    }

    /// Add one per-launch source marker to the owned GSI sender. The durable
    /// session journal precedes both mutations so recovery can restore either
    /// side of an interrupted config/installation-record update.
    pub(crate) fn prepare_gsi_source(
        &self,
        journal: &mut SessionRecord,
        ticket: &str,
        source_id: &str,
        uri: &str,
    ) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        if source_id.len() != 36
            || !source_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
            || uri != format!("http://127.0.0.1:3000/gsi?source={source_id}")
        {
            return Err("受管游戏来源响应无效。".into());
        }
        let state_path = self
            .root
            .parent()
            .ok_or("来源配置路径无效。")?
            .join("gsi-install/install.json");
        let installation_bytes = fs::read(&state_path).map_err(|_| "GSI 安装记录不可用。")?;
        let mut installation: Value =
            serde_json::from_slice(&installation_bytes).map_err(|_| "GSI 安装记录不可用。")?;
        self.validate_gsi_token(&installation)?;
        let cfg = PathBuf::from(
            installation["cfgPath"]
                .as_str()
                .ok_or("GSI 配置路径缺失。")?,
        );
        if cfg.file_name().and_then(|x| x.to_str()) != Some("gamestate_integration_mizar.cfg") {
            return Err("GSI 配置路径无效。".into());
        }
        let executable = Path::new(&journal.executable);
        let game = executable.ancestors().nth(3).ok_or("游戏路径无效。")?;
        let expected_cfg = game.join("csgo/cfg/gamestate_integration_mizar.cfg");
        if fs::canonicalize(&cfg).ok() != fs::canonicalize(&expected_cfg).ok()
            || fs::canonicalize(&cfg).is_err()
        {
            return Err("GSI 配置不属于本次游戏安装。".into());
        }
        let original = fs::read(&cfg).map_err(|_| "GSI 配置不可读。")?;
        if original.len() > 64 * 1024
            || format!("{:x}", Sha256::digest(&original))
                != installation["cfgFingerprint"].as_str().unwrap_or("")
        {
            return Err("GSI 配置已变化，未修改。".into());
        }
        let text = std::str::from_utf8(&original).map_err(|_| "GSI 配置不可读。")?;
        let token = installation["gsiToken"]
            .as_str()
            .ok_or("GSI 安装记录无效。")?;
        if text.matches(&format!("\"{token}\"")).count() != 1 {
            return Err("GSI 配置与安装记录不一致。".into());
        }
        let old_uri = "http://127.0.0.1:3000/gsi";
        if text.matches(old_uri).count() != 1 || text.contains("/gsi?source=") {
            return Err("GSI 配置不支持受管来源，请先恢复。".into());
        }
        let applied = text.replacen(old_uri, uri, 1);
        let original_hash = format!("{:x}", Sha256::digest(&original));
        let applied_hash = format!("{:x}", Sha256::digest(applied.as_bytes()));
        let backup = self.root.join("gsi-source-original.cfg");
        atomic_write(&backup, &original)?;
        journal.gsi_source = Some(GsiSource::prepared(
            ticket,
            source_id,
            cfg.to_string_lossy().into_owned(),
            original_hash,
            applied_hash.clone(),
        ));
        self.save(journal)?;
        unchanged(&cfg, &original)?;
        atomic_write(&cfg, applied.as_bytes())?;
        unchanged(&state_path, &installation_bytes)?;
        installation["cfgFingerprint"] = json!(applied_hash);
        atomic_write(
            &state_path,
            &serde_json::to_vec_pretty(&installation).map_err(|_| "GSI 安装记录无法保存。")?,
        )?;
        Ok(())
    }

    /// Called only after the managed game has been confirmed stopped.
    pub(crate) fn restore_gsi_source(&self, journal: &mut SessionRecord) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let Some(source) = journal.gsi_source.as_ref() else {
            return Ok(());
        };
        let original_hash = source.original_hash.as_str();
        let applied_hash = source.applied_hash.as_str();
        let cfg = PathBuf::from(&source.cfg_path);
        let state_path = self
            .root
            .parent()
            .ok_or("来源配置路径无效。")?
            .join("gsi-install/install.json");
        let installation_bytes = fs::read(&state_path).map_err(|_| "GSI 安装记录不可用。")?;
        let mut installation: Value =
            serde_json::from_slice(&installation_bytes).map_err(|_| "GSI 安装记录不可用。")?;
        if installation["cfgPath"].as_str() != cfg.to_str() {
            return Err("GSI 恢复目标已变化。".into());
        }
        let backup = self.root.join("gsi-source-original.cfg");
        let original = fs::read(&backup).map_err(|_| "GSI 原配置备份不可读。")?;
        let current = fs::read(&cfg).map_err(|_| "GSI 配置不可读。")?;
        let current_hash = format!("{:x}", Sha256::digest(&current));
        let recorded_hash = installation["cfgFingerprint"].as_str().unwrap_or("");
        if format!("{:x}", Sha256::digest(&original)) != original_hash
            || (current_hash != original_hash && current_hash != applied_hash)
            || (recorded_hash != original_hash && recorded_hash != applied_hash)
        {
            return Err("GSI 配置已变化，原备份仍保留。".into());
        }
        if current_hash != original_hash {
            atomic_write(&cfg, &original)?;
        }
        unchanged(&state_path, &installation_bytes)?;
        installation["cfgFingerprint"] = json!(original_hash);
        atomic_write(
            &state_path,
            &serde_json::to_vec_pretty(&installation).map_err(|_| "GSI 安装记录无法保存。")?,
        )?;
        journal.gsi_source = None;
        self.save(journal)?;
        fs::remove_file(backup).map_err(|_| "GSI 备份清理失败。")?;
        Ok(())
    }

    pub(crate) fn verify_gsi_source(&self, journal: &SessionRecord) -> Result<(), String> {
        use sha2::{Digest, Sha256};
        let source = journal.gsi_source.as_ref().ok_or("受管来源记录无效。")?;
        let source_id = source.source_id.as_str();
        let cfg = PathBuf::from(&source.cfg_path);
        let applied_hash = source.applied_hash.as_str();
        let state_path = self
            .root
            .parent()
            .ok_or("来源配置路径无效。")?
            .join("gsi-install/install.json");
        let installation: Value =
            serde_json::from_slice(&fs::read(state_path).map_err(|_| "GSI 安装记录不可用。")?)
                .map_err(|_| "GSI 安装记录不可用。")?;
        self.validate_gsi_token(&installation)?;
        let bytes = fs::read(&cfg).map_err(|_| "GSI 配置不可读。")?;
        if installation["cfgPath"].as_str() != cfg.to_str()
            || installation["cfgFingerprint"].as_str() != Some(applied_hash)
            || format!("{:x}", Sha256::digest(&bytes)) != applied_hash
            || !std::str::from_utf8(&bytes)
                .map_err(|_| "GSI 配置不可读。")?
                .contains(&format!("http://127.0.0.1:3000/gsi?source={source_id}"))
        {
            return Err("受管 GSI 配置已变化。".into());
        }
        Ok(())
    }
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
    fn recover_spectator_snapshot_locked(
        &self,
        _guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        account: u32,
    ) -> Result<(), String> {
        // A live core journal must be handed off before the associated full
        // record can be removed, including when it belongs to an older session.
        if self.load()?.is_some() {
            return Err("core_pending".into());
        }
        crate::spectator_snapshot::recover(&self.root, video, executable, account, atomic_write)
    }
    /// Caller must verify the active Steam identity and confirm CS2 is stopped.
    pub(crate) fn restore_full_pending(
        &self,
        video: &Path,
        executable: &Path,
        account: u32,
    ) -> Result<Option<String>, String> {
        let guard = self.acquire_write_guard()?;
        if self.load()?.is_some() {
            return Err("core_pending".into());
        }
        if !self.full_spectator_pending() {
            return Ok(None);
        }
        if crate::spectator_snapshot::linked_session(&self.root)?.is_some() {
            if crate::spectator_snapshot::finish_unwritten_preparation(
                &self.root,
                video,
                executable,
                account,
                atomic_write,
            )? {
                return Ok(None);
            }
            if !crate::spectator_snapshot::has_terminal(&self.root)? {
                return Err("coordinated_recovery_required".into());
            }
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
    pub fn load(&self) -> Result<Option<SessionRecord>, String> {
        match fs::File::open(self.journal_path()) {
            Ok(file) => {
                const MAX_JOURNAL_BYTES: usize = 4 * 1024 * 1024;
                let mut bytes = Vec::new();
                file.take(MAX_JOURNAL_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| io_error("无法读取 CS2 恢复记录。", &error))?;
                if bytes.len() > MAX_JOURNAL_BYTES {
                    return Err("CS2 恢复记录过大，请检查原配置备份。".into());
                }
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "CS2 恢复记录损坏，请检查原配置备份。")?;
                SessionRecord::from_value(value).map(Some)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("无法读取 CS2 恢复记录。".into()),
        }
    }
    pub fn save(&self, value: &SessionRecord) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.save_locked(&guard, value)
    }
    fn save_locked(&self, _guard: &StoreGuard, record: &SessionRecord) -> Result<(), String> {
        record.validate()?;
        let previous = self.load()?;
        let full_pending = self.full_spectator_pending();
        // Ordinary sessions may continue, but cannot take over a pending full snapshot.
        if (previous.as_ref().is_some_and(|core| core.full_snapshot) && !record.full_snapshot)
            || (record.full_snapshot && !full_pending)
            || (full_pending && record.spectator_cfg)
        {
            return Err("snapshot_pending".into());
        }
        if record.full_snapshot {
            let previous = previous.ok_or("snapshot_pending")?;
            let session = record
                .session_identity()
                .map_err(str::to_string)?
                .ok_or("snapshot_pending")?;
            if !previous.full_snapshot
                || previous
                    .session_identity()
                    .map_err(str::to_string)?
                    .as_ref()
                    != Some(&session)
                || crate::spectator_snapshot::linked_session(&self.root)?.as_ref() != Some(&session)
                || crate::spectator_snapshot::has_terminal(&self.root)?
                || !previous.allows_snapshot_update(record)
            {
                return Err("snapshot_pending".into());
            }
        }
        let bytes = serde_json::to_vec_pretty(record).map_err(|_| "CS2 恢复记录无法保存。")?;
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
        let bytes =
            serde_json::to_vec_pretty(record).map_err(|e| json_error("观战备份无法保存。", &e))?;
        if bytes.len() > 1024 * 1024 - 16384 {
            return Err("观战恢复记录过大，未应用观战配置。".into());
        }
        atomic_write(&self.spectator_path(), &bytes)?;
        crate::cs2_spectator::startup_files(record, crate::cs2_spectator::StartupFiles::Apply)
    }
    pub(crate) fn mulnx_observer_unconfirmed(&self) -> Result<bool, String> {
        Ok(self.spectator_record()?.is_some_and(|record| {
            record["mulnx"].is_object()
                && record["loadAttempted"] == true
                && record["mulnx"]["pid"].is_null()
                && record["mulnx"]["finished"] != true
        }))
    }
    pub(crate) fn mark_mulnx_options_clean(&self) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        let mut record = self.spectator_record()?.ok_or("观战备份缺失。")?;
        if !record["mulnx"].is_object() {
            return Err("MulNX 观战记录缺失。".into());
        }
        record["mulnx"]["optionsClean"] = json!(true);
        atomic_write(
            &self.spectator_path(),
            &serde_json::to_vec_pretty(&record)
                .map_err(|e| json_error("观战状态无法保存。", &e))?,
        )
    }
    pub(crate) fn mulnx_observer_matches(
        &self,
        pid: u32,
        created: u64,
        executable: &Path,
    ) -> Result<Option<bool>, String> {
        let Some(record) = self.spectator_record()? else {
            return Ok(None);
        };
        let actual =
            fs::canonicalize(executable).map_err(|e| io_error("游戏路径无法确认。", &e))?;
        if record["loadAttempted"] != true
            || record["mulnx"]["pid"] != json!(pid)
            || record["mulnx"]["created"] != json!(created)
            || record["mulnx"]["executable"] != json!(actual)
        {
            return Ok(None);
        }
        Ok(Some(crate::cs2_spectator::has_hud(&record)?))
    }
    pub(crate) fn mulnx_observer_target(&self) -> Result<Option<(PathBuf, PathBuf, u32)>, String> {
        let Some(record) = self.spectator_record()? else {
            return Ok(None);
        };
        if !record["mulnx"].is_object() {
            return Ok(None);
        }
        let video = record["video"].as_str().ok_or("观战恢复目标缺失。")?;
        let executable = record["mulnx"]["executable"]
            .as_str()
            .ok_or("观战恢复目标缺失。")?;
        let account = record["mulnx"]["account"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("观战恢复账号缺失。")?;
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
        crate::cs2_spectator::validate_prepared(&record)?;
        crate::cs2_spectator::startup_files(&record, crate::cs2_spectator::StartupFiles::Validate)?;
        Ok(())
    }
    pub fn spectator_hud_identity(&self) -> Result<Option<String>, String> {
        let record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if !crate::cs2_spectator::has_hud(&record)? {
            return Ok(None);
        }
        let identity = record["hud"]["identity"]
            .as_str()
            .ok_or("HUD 键身份缺失。")?;
        crate::cs2_spectator::hud_cfg_name(identity)?;
        Ok(Some(identity.to_string()))
    }
    /// Persist the possible +exec write before submitting Steam's request.
    /// A definitively failed spawn can disarm it; an ambiguous launch cannot.
    pub fn spectator_load_attempted(&self, attempted: bool) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.spectator_load_attempted_locked(&guard, attempted)
    }
    fn spectator_load_attempted_locked(
        &self,
        _guard: &StoreGuard,
        attempted: bool,
    ) -> Result<(), String> {
        if attempted {
            self.validate_spectator_launch()?;
        }
        let mut record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if record["version"] != 2 && record["version"] != 3 && record["version"] != 4 {
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
            if record["version"] != 1
                && record["version"] != 2
                && record["version"] != 3
                && record["version"] != 4
            {
                return Err("观战恢复记录版本不支持。".into());
            }
            let video = Path::new(record["video"].as_str().ok_or("观战恢复路径缺失。")?);
            if !video.is_absolute() || video.file_name().is_none_or(|v| v != "cs2_video.txt") {
                return Err("观战恢复路径无效。".into());
            }
            // CFGs may already have been applied before Steam was submitted.
            let startup_result = crate::cs2_spectator::startup_files(
                &record,
                crate::cs2_spectator::StartupFiles::Restore,
            );
            if record["version"] != 1 {
                match record["loadAttempted"].as_bool() {
                    Some(false) => {
                        startup_result?;
                        return fs::remove_file(self.spectator_path())
                            .map_err(|e| io_error("未加载的观战备份记录未能清理，请重试。", &e));
                    }
                    Some(true) => (),
                    None => return Err("观战加载记录无法核实，原值备份仍保留。".into()),
                }
            }
            let bindings_result = match record["version"].as_u64() {
                Some(2) => {
                    crate::cs2_spectator::restore_keys(video, Some(&record["bindings"]), None)
                }
                Some(3) => crate::cs2_spectator::restore_keys(
                    video,
                    Some(&record["bindings"]),
                    Some(&record["hud"]),
                ),
                Some(4) => crate::cs2_spectator::restore_keys(video, None, Some(&record["hud"])),
                _ => Ok(()), // Version 1 owns only the spectator convar.
            };
            let convar_result = (|| {
                if record["version"] == 4 {
                    return Ok(());
                }
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
                .chain(startup_result.err())
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
    fn preserve_playback_cleanup_locked(
        &self,
        _guard: &StoreGuard,
        value: &Value,
    ) -> Result<(), String> {
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

    pub fn set_preferences(&self, preferences: Preferences) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.set_preferences_locked(&guard, preferences)
    }
    fn set_preferences_locked(
        &self,
        _guard: &StoreGuard,
        preferences: Preferences,
    ) -> Result<(), String> {
        // Preferences are for the next launch only. The active session's
        // original/applied values and restoration ownership stay immutable.
        atomic_write(
            &self.root.join("preferences.json"),
            &serde_json::to_vec(&preferences.json()).unwrap(),
        )
    }

    pub(crate) fn check_start_recovery(&self) -> Result<(), String> {
        if self.load()?.is_some() || self.full_spectator_pending() {
            return Err("请先完成上次游戏设置恢复。".into());
        }
        // Even an unsubmitted record may already own applied startup scripts.
        if self.spectator_record()?.is_some() {
            return Err("请先恢复上次观战原值。".into());
        }
        Ok(())
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
        let files = original_files(video)?;
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
        for (path, bytes) in files {
            let name = path.file_name().ok_or("备份文件名缺失。")?;
            match bytes {
                Some(bytes) => atomic_write(&snapshot.join(name), &bytes)?,
                None => absent.push(name.to_string_lossy().to_string()),
            }
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
    pub fn import_selected_backup(
        &self,
        video: &Path,
        executable: &Path,
        backup: &str,
        original: &str,
        frame: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let guard = self.acquire_write_guard()?;
        self.import_selected_backup_locked(&guard, video, executable, backup, original, frame)
    }
    fn import_selected_backup_locked(
        &self,
        guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        backup: &str,
        original: &str,
        frame: Option<(&str, &str)>,
    ) -> Result<(), String> {
        if self.spectator_pending() {
            return Err("请先完成上次观战恢复。".into());
        }
        let restored = cs2_video::compatible_restore(backup, original)?;
        let machine = video
            .parent()
            .ok_or("配置目录缺失。")?
            .join("cs2_machine_convars.vcfg");
        let mut files = vec![
            json!({"name":"cs2_video.txt", "original":original, "restored":restored, "backup":backup}),
        ];
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
        self.save_locked(guard, &SessionRecord::from_value(record.clone())?)?;
        self.restore_selected_backup_locked(guard, &record)
    }
    fn restore_selected_backup_locked(
        &self,
        _guard: &StoreGuard,
        record: &Value,
    ) -> Result<(), String> {
        let video = Path::new(record["video"].as_str().ok_or("恢复目标缺失。")?);
        if !video.is_absolute()
            || video.file_name().is_none_or(|n| n != "cs2_video.txt")
            || fs::canonicalize(video).map_err(|e| io_error("恢复目标无法确认。", &e))? != video
        {
            return Err("恢复目标发生变化，原件与记录仍保留。".into());
        }
        let entries = record["files"].as_array().ok_or("恢复记录损坏。")?;
        if !(1..=2).contains(&entries.len()) {
            return Err("恢复文件范围无效。".into());
        }
        let mut plan = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            let name = if index == 0 {
                "cs2_video.txt"
            } else {
                "cs2_machine_convars.vcfg"
            };
            if entry["name"] != name {
                return Err("恢复文件范围无效。".into());
            }
            let original = entry["original"].as_str().ok_or("恢复原件缺失。")?;
            let restored = entry["restored"].as_str().ok_or("恢复内容缺失。")?;
            let backup = entry["backup"].as_str().ok_or("所选备份缺失。")?;
            if [original, restored, backup]
                .iter()
                .any(|v| v.len() > 256 * 1024)
            {
                return Err("恢复记录过大。".into());
            }
            let expected = if index == 0 {
                cs2_video::compatible_restore(backup, original)?
            } else {
                cs2_frame_rate::compatible_restore(backup, original)?
            };
            if expected != restored {
                return Err("恢复记录与字段范围不一致。".into());
            }
            let path = video.with_file_name(name);
            let metadata =
                fs::symlink_metadata(&path).map_err(|e| io_error("恢复文件无法读取。", &e))?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 256 * 1024
            {
                return Err("恢复文件类型或大小发生变化。".into());
            }
            let current = fs::read(&path).map_err(|e| io_error("恢复文件无法读取。", &e))?;
            if current != original.as_bytes() && current != restored.as_bytes() {
                return Err("配置已被其他程序修改，请检查后重试；原件仍保留。".into());
            }
            plan.push((path, current, restored));
        }
        // Validate every file before the first write; interrupted imports resume
        // idempotently and never overwrite new external bytes on retry.
        for (path, current, _) in &plan {
            unchanged(path, current)?;
        }
        for (path, current, restored) in plan {
            unchanged(&path, &current)?;
            if current != restored.as_bytes() {
                atomic_write(&path, restored.as_bytes())?;
            }
        }
        atomic_write(
            &self.root.join("last-selected-recovery.json"),
            &serde_json::to_vec_pretty(record).map_err(|_| "恢复记录无法保存。")?,
        )?;
        fs::remove_file(self.journal_path())
            .map_err(|e| io_error("设置已恢复，记录清理失败，请重试。", &e))
    }
    pub fn prepare_preserved(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<SessionRecord, String> {
        let guard = self.acquire_write_guard()?;
        self.prepare_preserved_locked(&guard, video, executable, size)
            .and_then(SessionRecord::from_value)
    }
    fn prepare_preserved_locked(
        &self,
        guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        self.check_start_recovery()?;
        self.backup_originals_locked(guard, video)?;
        let original = String::from_utf8(read_config_bytes(video, 128 * 1024)?)
            .map_err(|_| "视频配置编码不支持，未修改游戏设置。")?;
        let owned = cs2_video::launch_geometry(size);
        let applied = cs2_video::apply_geometry(&original, &owned)?;
        // The existing video-only transaction owns geometry, never rendering or FPS.
        let mut value = json!({"version":1,"preserveSettings":true,"video":video,"executable":executable,
            "original":original,"applied":applied,"owned":owned,"launchAttempted":false,"pid":null,"created":null});
        let spectator = crate::cs2_spectator::prepare_standalone(video, executable);
        let new_spectator = spectator.is_ok();
        let result = (|| {
            match spectator {
                Ok(record) => {
                    self.save_new_spectator_record(&record)?;
                    value["spectatorCfg"] = json!(true);
                    let native_hud_toggle = crate::cs2_spectator::has_hud(&record)?;
                    value["nativeHudToggle"] = json!(native_hud_toggle);
                    if native_hud_toggle {
                        value["hudIdentity"] = record["hud"]["identity"].clone();
                    }
                    if let Some(warning) = record["hudWarning"]
                        .as_str()
                        .or_else(|| record["numberWarning"].as_str())
                    {
                        value["spectatorWarning"] = json!(warning);
                    }
                }
                Err(warning) => value["spectatorWarning"] = json!(warning),
            }
            self.commit_files_locked(guard, &value, atomic_write)?;
            Ok(value)
        })();
        if result.is_err() && new_spectator && self.load()?.is_none() {
            if let Err(cleanup) = self.restore_spectator_locked(guard) {
                return Err(format!(
                    "{} 观战准备未能收尾：{cleanup}",
                    result.unwrap_err()
                ));
            }
        }
        result
    }

    /// Disk edits between preparation and submission are not launch permission.
    pub(crate) fn validate_video_launch(&self) -> Result<(), String> {
        let _guard = self.acquire_write_guard()?;
        let value = self.load()?.ok_or("游戏窗口配置事务缺失。")?.value();
        let video = Path::new(value["video"].as_str().ok_or("游戏窗口配置路径缺失。")?);
        let applied = value["applied"]
            .as_str()
            .ok_or("请先恢复原启动记录，再重新打开工作台。")?;
        if read_config_bytes(video, 128 * 1024)? != applied.as_bytes() {
            return Err("游戏配置在启动前发生变化，未启动游戏；请先恢复后重试。".into());
        }
        Ok(())
    }
    pub fn prepare_backed_up(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<SessionRecord, String> {
        let guard = self.acquire_write_guard()?;
        self.prepare_backed_up_locked(&guard, video, executable, size)
            .and_then(SessionRecord::from_value)
    }
    fn prepare_backed_up_locked(
        &self,
        guard: &StoreGuard,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        self.check_start_recovery()?;
        let preferences = self.preferences()?;
        let frames = cs2_frame_rate::prepare(video, executable, preferences.frame_rate_limit)?;
        // Video/FPS validation must finish before spectator::prepare can install a CFG.
        let mut journal = self.plan_files(video, executable, size, Some(frames.clone()))?;
        let spectator = crate::cs2_spectator::prepare(&frames, video, executable);
        let new_spectator = spectator.is_ok();
        let result = (|| {
            match spectator {
                Ok(record) => {
                    let frames = cs2_frame_rate::prepare_with_observer(
                        video,
                        executable,
                        preferences.frame_rate_limit,
                        true,
                    )?;
                    journal["frameRateFiles"] = json!(frames);
                    frame_files(&journal, video, executable)?;
                    // Save key originals before any startup CFG can execute our bindings.
                    self.save_new_spectator_record(&record)?;
                    journal["spectatorCfg"] = json!(true);
                    let native_hud_toggle = crate::cs2_spectator::has_hud(&record)?;
                    journal["nativeHudToggle"] = json!(native_hud_toggle);
                    if native_hud_toggle {
                        journal["hudIdentity"] = record["hud"]["identity"].clone();
                    }
                    if let Some(warning) = record["hudWarning"]
                        .as_str()
                        .or_else(|| record["numberWarning"].as_str())
                    {
                        journal["spectatorWarning"] = json!(warning);
                    }
                }
                Err(warning) => {
                    journal["spectatorWarning"] = json!(format!("数字键观战预设未应用：{warning}"));
                }
            }
            self.commit_files_locked(guard, &journal, atomic_write)?;
            Ok(journal)
        })();
        if result.is_err() && new_spectator && self.load()?.is_none() {
            // Only this call's unsubmitted optional record can be retired. A saved
            // core journal owns any partial write and must remain recoverable.
            if let Err(cleanup) = self.restore_spectator_locked(guard) {
                return Err(format!(
                    "{} 观战准备未能收尾：{cleanup}",
                    result.unwrap_err()
                ));
            }
        }
        result
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
        let bytes = read_config_bytes(video, 128 * 1024)?;
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
        self.save_locked(guard, &SessionRecord::from_value(value.clone())?)?;
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
    pub(crate) fn restore_coordinated(
        &self,
        video: &Path,
        executable: &Path,
        account: u32,
    ) -> Result<Option<String>, String> {
        let guard = self.acquire_write_guard()?;
        if let Some(record) = self.load()? {
            if !record.full_snapshot || record.unconfirmed_launch() {
                return Err("coordinated_recovery_required".into());
            }
            let core = record.value();
            crate::spectator_snapshot::handoff(
                &self.root,
                video,
                executable,
                account,
                &core,
                atomic_write,
            )?;
            if crate::spectator_snapshot::handed_off_unwritten(&self.root, &core)? {
                let playback = self.preserve_playback_cleanup_locked(&guard, &core);
                if let Some(warning) = self.finish_core_restore_locked(&guard, playback, None)? {
                    return Ok(Some(warning));
                }
                if !crate::spectator_snapshot::finish_unwritten_preparation(
                    &self.root,
                    video,
                    executable,
                    account,
                    atomic_write,
                )? {
                    return Err("snapshot_changed".into());
                }
                return Ok(None);
            }
            if let Some(warning) = self.restore_core_locked(&guard, true)? {
                return Ok(Some(warning));
            }
        } else if !self.full_spectator_pending() {
            return Ok(None);
        } else if !crate::spectator_snapshot::has_terminal(&self.root)? {
            return Err("coordinated_recovery_required".into());
        }
        if crate::spectator_snapshot::finish_unwritten_preparation(
            &self.root,
            video,
            executable,
            account,
            atomic_write,
        )? {
            return Ok(None);
        }
        match crate::spectator_snapshot::recover(
            &self.root,
            video,
            executable,
            account,
            atomic_write,
        ) {
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
    fn restore_core_locked(
        &self,
        guard: &StoreGuard,
        handoff_complete: bool,
    ) -> Result<Option<String>, String> {
        let Some(value) = self.load()? else {
            return Ok(None);
        };
        if value.unconfirmed_launch() {
            return Err("Steam 启动结果待确认，恢复记录与备份仍保留。".into());
        }
        let value = value.value();
        if value["fullSnapshot"] == true && !handoff_complete {
            return Err("coordinated_recovery_required".into());
        }
        if value["version"] == 4 {
            self.restore_selected_backup_locked(guard, &value)?;
            return Ok(None);
        }
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
        let geometry_only = value["preserveSettings"] == true;
        let expected = if geometry_only {
            if value["version"] != 1
                || value.get("frameRateFiles").is_some()
                || value.get("frameRateLimit").is_some()
            {
                return Err("窗口几何恢复记录范围无效。".into());
            }
            cs2_video::apply_geometry(original, &owned)?
        } else {
            if !cs2_video::supported_preset(&owned) {
                return Err("CS2 字段恢复记录不支持。".into());
            }
            cs2_video::apply(original, &owned)?
        };
        if expected != applied {
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
        let current = String::from_utf8(read_config_bytes(path, 128 * 1024)?)
            .map_err(|_| "游戏视频配置编码不支持，原配置备份仍保留。")?;
        let (restored, geometry_yielded) = if current == original {
            (current.clone(), false)
        } else if geometry_only {
            cs2_video::restore_geometry(original, applied, &current, &owned)?
        } else {
            (
                cs2_video::restore(original, applied, &current, &owned)?,
                false,
            )
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
        let mut warning = self.restore_core_spectator_locked(guard);
        if geometry_yielded {
            let notice = "窗口设置已被更改，已保留这些新值；其余受管设置已恢复。";
            warning = Some(match warning {
                Some(other) => format!("{notice} {other}"),
                None => notice.into(),
            });
        }
        self.finish_core_restore_locked(guard, playback_handoff, warning)
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
