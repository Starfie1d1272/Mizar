//! Durable physical configuration transaction; production state remains in Companion.
use crate::cs2_video;
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
                if bytes.len() > 1024 * 1024 {
                    return Err("CS2 恢复记录过大，请检查原配置备份。".into());
                }
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "CS2 恢复记录损坏，请检查原配置备份。")?;
                if value["version"] != 1 {
                    return Err("CS2 恢复记录版本不支持。".into());
                }
                Ok(Some(value))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("无法读取 CS2 恢复记录。".into()),
        }
    }
    pub fn save(&self, value: &Value) -> Result<(), String> {
        atomic_write(
            &self.journal_path(),
            &serde_json::to_vec_pretty(value).map_err(|_| "CS2 恢复记录无法保存。")?,
        )
    }
    pub fn preferences(&self) -> Result<bool, String> {
        match fs::read(self.root.join("preferences.json")) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v["preserveQuality"].as_bool())
                .ok_or_else(|| "CS2 画质设置无法读取。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("CS2 画质设置无法读取。".into()),
        }
    }
    pub fn set_preferences(&self, preserve: bool) -> Result<(), String> {
        if self.load()?.is_some() {
            return Err("请结束制作并恢复配置后再修改画质选项。".into());
        }
        atomic_write(
            &self.root.join("preferences.json"),
            &serde_json::to_vec(&json!({"preserveQuality": preserve})).unwrap(),
        )
    }
    pub fn prepare(&self, video: &Path, executable: &Path) -> Result<Value, String> {
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
        let owned = cs2_video::preset(self.preferences()?);
        let applied = cs2_video::apply(&original, &owned)?;
        let value = json!({"version":1,"video":video,"executable":executable,"original":original,"applied":applied,"owned":owned,"launchAttempted":false,"pid":null,"created":null});
        // The original is durable and read-back verified before touching the game.
        self.save(&value)?;
        if let Err(error) = atomic_write(video, applied.as_bytes()) {
            return Err(error);
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
        if owned != cs2_video::preset(true) && owned != cs2_video::preset(false) {
            return Err("CS2 字段恢复记录不支持。".into());
        }
        if cs2_video::apply(original, &owned)? != applied {
            return Err("CS2 原配置与应用记录不一致，备份仍保留。".into());
        }
        let current =
            fs::read_to_string(path).map_err(|_| "无法读取游戏视频配置；原配置备份仍保留。")?;
        let restored = if current == original {
            current
        } else {
            cs2_video::restore(original, applied, &current, &owned)?
        };
        atomic_write(path, restored.as_bytes())?;
        // Keep a readable, exact original even after successful recovery.
        atomic_write(&self.root.join("last-original.txt"), original.as_bytes())?;
        fs::remove_file(self.journal_path())
            .map_err(|_| "原配置已恢复，但恢复记录尚未清理，请重试。".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, PathBuf, SessionStore) {
        let root = std::env::temp_dir().join(format!(
            "mizar-cs2-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let video = root.join("cs2_video.txt");
        fs::write(&video, b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }").unwrap();
        let store = SessionStore::new(root.clone());
        (root, video, store)
    }
    #[test]
    fn a_timed_out_steam_request_survives_restart_until_confirmed() {
        let (root, video, store) = setup();
        let mut journal = store.prepare(&video, &root.join("cs2.exe")).unwrap();
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
        store.set_preferences(true).unwrap();
        assert!(store.preferences().unwrap());
        store.prepare(&video, &root.join("cs2.exe")).unwrap();
        let backup = fs::read(store.journal_path()).unwrap();
        assert!(store.prepare(&video, &root.join("cs2.exe")).is_err());
        assert!(store.set_preferences(false).is_err());
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
        store.prepare(&video, &root.join("cs2.exe")).unwrap();
        let current = "unknown format".to_string();
        fs::write(&video, &current).unwrap();
        assert!(store.restore().is_err());
        assert!(store.load().unwrap().is_some());
        assert_eq!(fs::read_to_string(&video).unwrap(), current);
        fs::remove_dir_all(root).unwrap();
        let (root, video, store) = setup();
        fs::write(&video, "unknown format").unwrap();
        assert!(store.prepare(&video, &root.join("cs2.exe")).is_err());
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
        assert!(store.prepare(&video, &root.join("cs2.exe")).is_err());
        assert_eq!(fs::read(&video).unwrap(), original);
        fs::remove_file(&store.root).unwrap();
        store.prepare(&video, &root.join("cs2.exe")).unwrap();
        fs::remove_file(&video).unwrap();
        assert!(store.restore().is_err());
        assert!(store.load().unwrap().is_some());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn completed_write_with_pending_journal_recovers_idempotently() {
        let (root, video, store) = setup();
        let journal = store.prepare(&video, &root.join("cs2.exe")).unwrap();
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
