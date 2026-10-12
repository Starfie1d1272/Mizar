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

pub struct SessionStore {
    root: PathBuf,
}
impl SessionStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: root.join("data/cs2-session"),
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
                if value["version"] != 1 && value["version"] != 2 && value["version"] != 3 {
                    return Err("CS2 恢复记录版本不支持。".into());
                }
                Ok(Some(value))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("无法读取 CS2 恢复记录。".into()),
        }
    }
    pub fn save(&self, value: &Value) -> Result<(), String> {
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
    pub fn spectator_warning(&self) -> Option<String> {
        match self.spectator_record() {
            Ok(Some(record)) => record["warning"].as_str().map(str::to_string),
            Ok(None) => None,
            Err(error) => Some(error),
        }
    }
    pub fn validate_spectator_launch(&self) -> Result<(), String> {
        let record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if record["version"] != 2 {
            return Err("观战原绑定备份版本无法核实。".into());
        }
        let video = Path::new(record["video"].as_str().ok_or("观战恢复路径缺失。")?);
        crate::cs2_spectator::check_archive(video)?;
        crate::cs2_spectator::validate_bindings(video, &record["bindings"])
    }
    /// Persist the possible +exec write before submitting Steam's request.
    /// A definitively failed spawn can disarm it; an ambiguous launch cannot.
    pub fn spectator_load_attempted(&self, attempted: bool) -> Result<(), String> {
        if attempted {
            self.validate_spectator_launch()?;
        }
        let mut record = self.spectator_record()?.ok_or("观战原值备份缺失。")?;
        if record["version"] != 2 {
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
        let Some(mut record) = self.spectator_record()? else {
            return Ok(());
        };
        let result = (|| {
            if record["version"] != 1 && record["version"] != 2 {
                return Err("观战恢复记录版本不支持。".into());
            }
            let video = Path::new(record["video"].as_str().ok_or("观战恢复路径缺失。")?);
            if !video.is_absolute() || video.file_name().is_none_or(|v| v != "cs2_video.txt") {
                return Err("观战恢复路径无效。".into());
            }
            if record["version"] == 2 {
                match record["loadAttempted"].as_bool() {
                    Some(false) => {
                        return fs::remove_file(self.spectator_path())
                            .map_err(|e| io_error("未加载的观战备份记录未能清理，请重试。", &e))
                    }
                    Some(true) => (),
                    None => return Err("观战加载记录无法核实，原值备份仍保留。".into()),
                }
            }
            let bindings_result = if record["version"] == 2 {
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
    fn preserve_playback_cleanup(&self, value: &Value) -> Result<(), String> {
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
    fn finish_core_restore(
        &self,
        handoff: Result<(), String>,
        spectator_error: Option<String>,
    ) -> Result<Option<String>, String> {
        let playback_error = match handoff {
            Ok(()) => {
                fs::remove_file(self.journal_path())
                    .map_err(|_| "原配置已恢复，但恢复记录尚未清理，请重试。".to_string())?;
                self.restore_playback_cleanup().err()
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
        if self.load()?.is_some() {
            return Err("请结束制作并恢复配置后再修改启动设置。".into());
        }
        atomic_write(
            &self.root.join("preferences.json"),
            &serde_json::to_vec(&preferences.json()).unwrap(),
        )
    }
    #[cfg(test)]
    pub fn prepare(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        self.prepare_files(video, executable, size, None)
    }
    /// Save opaque source bytes before attempting any interpretation. These
    /// incident snapshots are never automatically restored over later settings.
    pub fn backup_originals(&self, video: &Path) -> Result<(), String> {
        if self.load()?.is_some() {
            return Err("上次 CS2 配置尚未恢复，请先退出游戏并重试恢复。".into());
        }
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
        Ok(())
    }
    pub fn prepare_preserved(&self, video: &Path, executable: &Path) -> Result<Value, String> {
        self.backup_originals(video)?;
        let value = json!({"version":3,"preserveSettings":true,"video":video,"executable":executable,
            "launchAttempted":false,"pid":null,"created":null});
        self.save(&value)?;
        Ok(value)
    }
    pub fn prepare_with_frame_rate(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        self.backup_originals(video)?;
        self.prepare_backed_up(video, executable, size)
    }
    pub fn prepare_backed_up(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        let preferences = self.preferences()?;
        let frames = cs2_frame_rate::prepare(video, executable, preferences.frame_rate_limit)?;
        let spectator = if self.spectator_pending() {
            Err("上次观战字段尚未恢复，本次未加载观战 CFG；可退出游戏后重试恢复。".into())
        } else {
            crate::cs2_spectator::prepare(&frames, video, executable)
        };
        let mut journal = self.prepare_files(video, executable, size, Some(frames))?;
        let armed = spectator.and_then(|record| {
            // This exact original must survive core recovery and restart even if
            // optional restore later fails. Save it before allowing +exec.
            atomic_write(
                &self.spectator_path(),
                &serde_json::to_vec_pretty(&record)
                    .map_err(|error| json_error("观战原值备份无法保存。", &error))?,
            )?;
            Ok(())
        });
        match armed {
            Ok(()) => journal["spectatorCfg"] = json!(true),
            Err(warning) => {
                journal["spectatorWarning"] = json!(format!("数字键观战预设未应用：{warning}"))
            }
        }
        self.save(&journal)?;
        Ok(journal)
    }
    fn prepare_files(
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
        let frame_files = frame_files(&value, video, executable)?;
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
        self.save(&value)?;
        if let Err(error) = atomic_write(video, applied.as_bytes()) {
            return Err(error);
        }
        for (path, original, applied) in frame_files {
            if fs::read_to_string(path).map_err(|_| "无法读取启动配置，备份仍保留。")? != original
            {
                return Err("启动配置在应用期间发生变化，备份仍保留。".into());
            }
            atomic_write(path, applied.as_bytes())?;
        }
        Ok(value)
    }
    /// Caller must independently confirm no CS2 process can still write this file.
    pub fn restore(&self) -> Result<Option<String>, String> {
        let Some(value) = self.load()? else {
            return Ok(None);
        };
        if unconfirmed_launch(&value) {
            return Err("Steam 启动结果待确认，恢复记录与备份仍保留。".into());
        }
        let playback_handoff = self.preserve_playback_cleanup(&value);
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
            // Nothing was owned or changed. In particular, never replace game
            // writes made during this session with an incident snapshot.
            return self.finish_core_restore(playback_handoff, None);
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
                cs2_frame_rate::restored(&value["frameRateFiles"][index], &current)?,
            ));
        }
        let current =
            fs::read_to_string(path).map_err(|_| "无法读取游戏视频配置；原配置备份仍保留。")?;
        let restored = if current == original {
            current
        } else {
            cs2_video::restore(original, applied, &current, &owned)?
        };
        atomic_write(path, restored.as_bytes())?;
        for (frame_path, restored) in frame_restorations {
            atomic_write(frame_path, restored.as_bytes())?;
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
        let spectator_error = self.restore_spectator().err();
        self.finish_core_restore(playback_handoff, spectator_error)
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);
    fn setup() -> (PathBuf, PathBuf, SessionStore) {
        let root = std::env::temp_dir().join(format!(
            "mizar-cs2-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let video = root.join("cs2_video.txt");
        fs::write(&video, b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }").unwrap();
        let store = SessionStore::new(root.clone());
        (root, video, store)
    }
    fn frame_setup() -> (PathBuf, PathBuf, PathBuf, PathBuf, SessionStore) {
        let (root, _, store) = setup();
        let video = root.join("steam/userdata/1/730/local/cfg/cs2_video.txt");
        fs::create_dir_all(video.parent().unwrap()).unwrap();
        fs::copy(root.join("cs2_video.txt"), &video).unwrap();
        fs::write(
            video.parent().unwrap().join("cs2_user_keys_0_slot0.vcfg"),
            "\"config\" {\"bindings\" {}}",
        )
        .unwrap();
        let account = root.join("steam/userdata/1/config");
        fs::create_dir_all(&account).unwrap();
        fs::write(account.join("localconfig.vdf"), "\"UserLocalConfigStore\" {\"Software\" {\"Valve\" {\"Steam\" {\"Apps\" {\"730\" {\"LaunchOptions\" \"+exec auto.cfg\"}}}}}}").unwrap();
        let convars = video.parent().unwrap().join("cs2_machine_convars.vcfg");
        fs::write(
            &convars,
            "\"config\" {\"convars\" {\"fps_max\" \"0\" \"other\" \"keep\"}}",
        )
        .unwrap();
        let cfg = root.join("game/csgo/cfg");
        fs::create_dir_all(&cfg).unwrap();
        fs::write(
            cfg.join("auto.cfg"),
            "// private\r\nfps_max 0; exec crosshair.cfg\r\n",
        )
        .unwrap();
        fs::write(cfg.join("crosshair.cfg"), "cl_crosshairsize 2\n").unwrap();
        let executable = root.join("game/bin/win64/cs2.exe");
        (root, video, convars, executable, store)
    }
    #[test]
    fn production_safety_precedes_real_restore_and_restart_retries_failed_restore() {
        let (root, video, machine, executable, store) = frame_setup();
        let original_video = fs::read(&video).unwrap();
        let original_machine = fs::read(&machine).unwrap();
        store
            .prepare_with_frame_rate(
                &video,
                &executable,
                cs2_video::VideoSize::new(1440, 810).unwrap(),
            )
            .unwrap();
        let applied_video = fs::read(&video).unwrap();
        assert_ne!(applied_video, original_video);
        // An unconfirmed OBS safety transaction must leave the game files alone.
        assert!(crate::production_exit::finish_then_restore(
            || Err("OBS 运行状态未确认".into()),
            || store.restore().map(|_| ()),
        )
        .is_err());
        assert_eq!(fs::read(&video).unwrap(), applied_video);
        assert!(store.load().unwrap().is_some());
        // Safety can complete while the physical restoration fails. The original
        // journal survives, so a new Host can retry instead of losing the backup.
        fs::remove_file(&video).unwrap();
        fs::create_dir(&video).unwrap();
        assert!(crate::production_exit::finish_then_restore(
            || Ok(()),
            || store.restore().map(|_| ()),
        )
        .is_err());
        assert!(store.load().unwrap().is_some());
        fs::remove_dir(&video).unwrap();
        fs::write(&video, &applied_video).unwrap();
        let restarted = SessionStore::new(root.clone());
        crate::production_exit::finish_then_restore(|| Ok(()), || restarted.restore().map(|_| ()))
            .unwrap();
        assert_eq!(fs::read(&video).unwrap(), original_video);
        assert_eq!(fs::read(&machine).unwrap(), original_machine);
        assert!(restarted.load().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }





    #[test]
    fn observer_cfg_restores_boolean_and_ten_bindings_preserving_other_game_edits() {
        for token in ["0", "1", "false", "true"] {
            let (root, video, machine, executable, store) = frame_setup();
            let original = format!("\"config\" {{\"convars\" {{\"fps_max\" \"230.43442\" \"spec_usenumberkeys_nobinds\" \"{token}\" \"other\" \"old\"}}}}");
            fs::write(&machine, &original).unwrap();
            let keys = video.parent().unwrap().join("cs2_user_keys_0_slot0.vcfg");
            let bindings = "\"config\" {\"bindings\" {\"1\" \"say custom; slot7\" \"2\" \"\" \"4\" \"slot4\" \"0\" \"say zero custom\" \"x\" \"original\"}}";
            fs::write(&keys, bindings).unwrap();
            let journal = store
                .prepare_with_frame_rate(
                    &video,
                    &executable,
                    cs2_video::VideoSize::new(1440, 810).unwrap(),
                )
                .unwrap();
            assert_eq!(journal["spectatorCfg"], true);
            let applied = fs::read_to_string(&machine).unwrap();
            assert!(applied.contains(&format!("\"spec_usenumberkeys_nobinds\" \"{token}\"")));
            assert!(store.spectator_pending());
            let cfg = root.join("game/csgo/cfg/mizar_observer.cfg");
            let commands = fs::read_to_string(&cfg).unwrap();
            assert!(commands
                .lines()
                .any(|line| line == "spec_usenumberkeys_nobinds 0"));
            for number in 1..=9 {
                assert!(commands
                    .lines()
                    .any(|line| line == format!("bind \"{number}\" \"slot{number}\"")));
            }
            assert!(commands.lines().any(|line| line == "bind \"0\" \"slot10\""));
            assert!(!commands.contains("bind \"0\" \"slot0\""));
            assert_eq!(fs::read_to_string(&keys).unwrap(), bindings); // No prelaunch key writes.
            let backup = store.spectator_record().unwrap().unwrap();
            assert_eq!(backup["version"], 2);
            assert_eq!(backup["bindings"]["1"], "\"say custom; slot7\"");
            assert_eq!(backup["bindings"]["2"], "\"\"");
            assert_eq!(backup["bindings"]["3"], Value::Null);
            assert_eq!(backup["bindings"].as_object().unwrap().len(), 10);
            store.validate_spectator_launch().unwrap();
            store.spectator_load_attempted(true).unwrap();
            crate::cs2_spectator::install(&executable).unwrap();
            fs::write(
                &machine,
                applied
                    .replace(&format!("\"{token}\""), "\"0\"")
                    .replace("\"old\"", "\"new\""),
            )
            .unwrap();
            fs::write(&keys, "\"config\" {\"bindings\" {\"1\" \"slot1\" \"2\" \"slot2\" \"3\" \"slot3\" \"4\" \"slot4\" \"5\" \"slot5\" \"6\" \"slot6\" \"7\" \"slot7\" \"8\" \"slot8\" \"9\" \"slot9\" \"0\" \"slot10\" \"x\" \"changed-other-key\"}}\n").unwrap();
            // A restart reconstructs the real recovery owner from the durable record.
            SessionStore::new(root.clone()).restore().unwrap();
            assert_eq!(
                fs::read_to_string(&machine).unwrap(),
                original.replace("\"old\"", "\"new\"")
            );
            let restored = fs::read_to_string(&keys).unwrap();
            for (key, expected) in [
                ("1", Some("say custom; slot7")),
                ("2", Some("")),
                ("3", None),
                ("4", Some("slot4")),
                ("5", None),
                ("6", None),
                ("7", None),
                ("8", None),
                ("9", None),
                ("0", Some("say zero custom")),
                ("x", Some("changed-other-key")),
            ] {
                assert_eq!(
                    cs2_frame_rate::field(&restored, &["config", "bindings", key])
                        .unwrap()
                        .map(|token| token.value),
                    expected.map(str::to_string)
                );
            }
            assert!(!video
                .parent()
                .unwrap()
                .join("cs2_user_keys_0_slot1.vcfg")
                .exists());
            assert!(store.load().unwrap().is_none());
            assert!(!store.spectator_pending());
            fs::remove_dir_all(root).unwrap();
        }
    }


















    #[test]
    fn durable_restart_recovery_does_not_overwrite_pending_backup() {
        let (root, video, store) = setup();
        let original = fs::read(&video).unwrap();
        store
            .set_preferences(Preferences::new("preserve", 60).unwrap())
            .unwrap();
        assert_eq!(
            store.preferences().unwrap().quality,
            crate::cs2_preferences::Quality::Preserve
        );
        store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        let backup = fs::read(store.journal_path()).unwrap();
        assert!(store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap()
            )
            .is_err());
        assert!(store.set_preferences(Preferences::default()).is_err());
        assert_eq!(fs::read(store.journal_path()).unwrap(), backup);
        let restarted = SessionStore::new(root.clone());
        restarted.restore().unwrap();
        assert_eq!(fs::read(&video).unwrap(), original);
        restarted.restore().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_failure_does_not_modify_game_and_missing_file_keeps_recovery() {
        let (root, video, store) = setup();
        let original = fs::read(&video).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(&store.root, "blocked directory").unwrap();
        assert!(store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap()
            )
            .is_err());
        assert_eq!(fs::read(&video).unwrap(), original);
        fs::remove_file(&store.root).unwrap();
        store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        fs::remove_file(&video).unwrap();
        assert!(store.restore().is_err());
        assert!(store.load().unwrap().is_some());
        fs::remove_dir_all(root).unwrap();
    }

}
