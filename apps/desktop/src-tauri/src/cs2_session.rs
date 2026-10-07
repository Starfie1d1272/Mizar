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

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("配置路径无效。")?;
    fs::create_dir_all(parent).map_err(|_| "无法创建配置目录。")?;
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
            .map_err(|_| "无法准备配置写入。")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "配置未能完整保存。")?;
        drop(file);
        replace(&temp, path)?;
        if fs::read(path).map_err(|_| "配置读回验证失败。")? != bytes {
            return Err("配置读回验证失败。".into());
        }
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|_| "配置写入失败，备份仍保留。".into())
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
        Err("配置写入失败，备份仍保留。".into())
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
                if value["version"] != 1 && value["version"] != 2 {
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
    pub fn prepare_with_frame_rate(
        &self,
        video: &Path,
        executable: &Path,
        size: cs2_video::VideoSize,
    ) -> Result<Value, String> {
        let frames =
            cs2_frame_rate::prepare(video, executable, self.preferences()?.frame_rate_limit)?;
        self.prepare_files(video, executable, size, Some(frames))
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
    pub fn restore(&self) -> Result<(), String> {
        let Some(value) = self.load()? else {
            return Ok(());
        };
        if unconfirmed_launch(&value) {
            return Err("Steam 启动结果待确认，恢复记录与备份仍保留。".into());
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
        fs::remove_file(self.journal_path())
            .map_err(|_| "原配置已恢复，但恢复记录尚未清理，请重试。".to_string())
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
    fn frame_rate_startup_override_and_crash_recovery_restore_exact_user_config() {
        for limit in [60, 30, 0] {
            let (root, video, convars, executable, store) = frame_setup();
            store
                .set_preferences(Preferences::new("high", limit).unwrap())
                .unwrap();
            let before_video = fs::read(&video).unwrap();
            let before_convars = fs::read_to_string(&convars).unwrap();
            let cfg = root.join("game/csgo/cfg/auto.cfg");
            let before_cfg = fs::read(&cfg).unwrap();
            let journal = store
                .prepare_with_frame_rate(
                    &video,
                    &executable,
                    cs2_video::VideoSize::new(1920, 1080).unwrap(),
                )
                .unwrap();
            assert_eq!(journal["version"], 2);
            assert!(fs::read_to_string(&cfg)
                .unwrap()
                .contains(&format!("fps_max {limit};")));
            assert!(fs::read_to_string(&convars)
                .unwrap()
                .contains(&format!("\"fps_max\" \"{limit}\"")));
            let current = fs::read_to_string(&convars)
                .unwrap()
                .replace("\"keep\"", "\"changed\"");
            fs::write(&convars, current).unwrap();
            SessionStore::new(root.clone()).restore().unwrap();
            assert_eq!(fs::read(&video).unwrap(), before_video);
            assert_eq!(
                fs::read_to_string(&convars).unwrap(),
                before_convars.replace("\"keep\"", "\"changed\"")
            );
            assert_eq!(fs::read(&cfg).unwrap(), before_cfg);
            assert!(store.load().unwrap().is_none());
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn frame_rate_conflicts_do_not_overwrite_other_files_or_clear_backups() {
        let (root, video, convars, executable, store) = frame_setup();
        let cfg = root.join("game/csgo/cfg/auto.cfg");
        store
            .prepare_with_frame_rate(
                &video,
                &executable,
                cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        let applied_video = fs::read(&video).unwrap();
        let applied_convars = fs::read(&convars).unwrap();
        fs::write(&cfg, "fps_max 60; // external edit").unwrap();
        assert!(store.restore().is_err());
        assert!(store.load().unwrap().is_some());
        assert_eq!(fs::read(&video).unwrap(), applied_video);
        assert_eq!(fs::read(&convars).unwrap(), applied_convars);
        fs::remove_dir_all(root).unwrap();
        let (root, video, _, executable, store) = frame_setup();
        let original = fs::read(&video).unwrap();
        fs::write(root.join("game/csgo/cfg/auto.cfg"), "exec ../outside.cfg").unwrap();
        assert!(store
            .prepare_with_frame_rate(
                &video,
                &executable,
                cs2_video::VideoSize::new(1920, 1080).unwrap()
            )
            .is_err());
        assert_eq!(fs::read(&video).unwrap(), original);
        assert!(store.load().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn sized_launch_restores_after_restart_and_rejects_extra_owned_fields() {
        for (width, height) in [(1440, 810), (1920, 1080), (2880, 1620)] {
            let (root, video, store) = setup();
            let original = fs::read(&video).unwrap();
            let size = cs2_video::VideoSize::new(width, height).unwrap();
            let mut journal = store.prepare(&video, &root.join("cs2.exe"), size).unwrap();
            assert_eq!(journal["owned"]["setting.defaultres"], width.to_string());
            assert_eq!(
                journal["owned"]["setting.defaultresheight"],
                height.to_string()
            );
            journal["owned"]["unrelated"] = json!("modified");
            store.save(&journal).unwrap();
            let applied = fs::read(&video).unwrap();
            assert!(store.restore().is_err());
            assert_eq!(fs::read(&video).unwrap(), applied);
            journal["owned"]
                .as_object_mut()
                .unwrap()
                .remove("unrelated");
            store.save(&journal).unwrap();
            SessionStore::new(root.clone()).restore().unwrap();
            assert_eq!(fs::read(&video).unwrap(), original);
            fs::remove_dir_all(root).unwrap();
        }
        assert!(cs2_video::VideoSize::new(1920, 0).is_err());
        assert!(cs2_video::VideoSize::new(1920, 1200).is_err());
        assert!(cs2_video::VideoSize::new(-16, -9).is_err());
    }
    #[test]
    fn a_timed_out_steam_request_survives_restart_until_confirmed() {
        let (root, video, store) = setup();
        let mut journal = store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        journal["launchAttempted"] = json!(true);
        journal["launchTime"] = json!(42);
        store.save(&journal).unwrap();
        let applied = fs::read(&video).unwrap();
        let restarted = SessionStore::new(root.clone());
        assert!(unconfirmed_launch(&restarted.load().unwrap().unwrap()));
        assert!(restarted.restore().is_err());
        assert_eq!(fs::read(&video).unwrap(), applied);
        assert!(restarted.load().unwrap().is_some());
        // An explicit cancelled-request acknowledgement is durable too.
        journal["launchCancelled"] = json!(true);
        restarted.save(&journal).unwrap();
        restarted.restore().unwrap();
        assert_eq!(
            fs::read_to_string(&video).unwrap(),
            journal["original"].as_str().unwrap()
        );
        assert!(restarted.load().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
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
    fn invalid_formats_keep_original_and_pending_record() {
        let (root, video, store) = setup();
        store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        let current = "unknown format".to_string();
        fs::write(&video, &current).unwrap();
        assert!(store.restore().is_err());
        assert!(store.load().unwrap().is_some());
        assert_eq!(fs::read_to_string(&video).unwrap(), current);
        fs::remove_dir_all(root).unwrap();
        let (root, video, store) = setup();
        fs::write(&video, "unknown format").unwrap();
        assert!(store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap()
            )
            .is_err());
        assert!(store.load().unwrap().is_none());
        assert_eq!(fs::read_to_string(&video).unwrap(), "unknown format");
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
    #[test]
    fn completed_write_with_pending_journal_recovers_idempotently() {
        let (root, video, store) = setup();
        let journal = store
            .prepare(
                &video,
                &root.join("cs2.exe"),
                cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        let current = fs::read_to_string(&video)
            .unwrap()
            .replace("\"1920\"", "\"1856\"")
            .replace("}", "\"unrelated\" \"changed\" }");
        let owned = cs2_video::preset(false);
        let restored = cs2_video::restore(
            journal["original"].as_str().unwrap(),
            journal["applied"].as_str().unwrap(),
            &current,
            &owned,
        )
        .unwrap();
        fs::write(&video, &restored).unwrap();
        store.restore().unwrap();
        assert_eq!(fs::read_to_string(&video).unwrap(), restored);
        assert!(store.load().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
