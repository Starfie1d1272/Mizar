use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

pub const UPDATE_WRITER_MUTEX: &str = "Global\\MizarUpdateWriter";
pub const DESKTOP_MUTEX: &str = "Global\\MizarDesktop";
pub const UPDATE_ACTIVE_EVENT: &str = "Global\\MizarUpdateActive";
pub const UPDATE_WINDOW_TITLE: &str = "Mizar 应用更新";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentPointer {
    pub schema_version: u32,
    pub current: String,
    pub previous: Option<String>,
    pub updated_at: String,
}

pub fn is_valid_version_id(id: &str) -> bool {
    let Some((ver_part, rest)) = id.split_once('-') else {
        return false;
    };
    if parse_semver_triplet(ver_part).is_none() {
        return false;
    }
    let mut parts = rest.split('-');
    let Some(sha8) = parts.next() else {
        return false;
    };
    if sha8.len() != 8 || !sha8.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(nonce6) => {
            parts.next().is_none()
                && nonce6.len() == 6
                && nonce6
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        }
    }
}

pub fn parse_semver_triplet(ver: &str) -> Option<(u64, u64, u64)> {
    let mut iter = ver.split('.');
    let major = iter.next()?.parse::<u64>().ok()?;
    let minor = iter.next()?.parse::<u64>().ok()?;
    let patch = iter.next()?.parse::<u64>().ok()?;
    if iter.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn version_id_semver(id: &str) -> Option<(u64, u64, u64)> {
    let (ver, _) = id.split_once('-')?;
    parse_semver_triplet(ver)
}

pub fn read_current_pointer(install_dir: &Path) -> Option<CurrentPointer> {
    let path = install_dir.join("current.json");
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let ptr: CurrentPointer = serde_json::from_slice(&bytes).ok()?;
    if ptr.schema_version != 2 || !is_valid_version_id(&ptr.current) {
        return None;
    }
    if let Some(prev) = &ptr.previous {
        if !is_valid_version_id(prev) {
            return None;
        }
    }
    Some(ptr)
}

pub fn write_current_pointer_atomic(install_dir: &Path, ptr: &CurrentPointer) -> io::Result<()> {
    let target = install_dir.join("current.json");
    let tmp = install_dir.join(format!("current.json.{}.tmp", std::process::id()));
    let json = serde_json::to_vec_pretty(ptr).map_err(io::Error::other)?;
    {
        let mut file = File::create(&tmp)?;
        file.write_all(&json)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    replace_file_atomic(&tmp, &target)
}

pub fn replace_file_atomic(src: &Path, dst: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
        }
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        let src_w: Vec<u16> = src.as_os_str().encode_wide().chain(Some(0)).collect();
        let dst_w: Vec<u16> = dst.as_os_str().encode_wide().chain(Some(0)).collect();
        let ok = unsafe {
            MoveFileExW(
                src_w.as_ptr(),
                dst_w.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(src, dst)
    }
}

pub fn is_reparse_point(path: &Path) -> io::Result<bool> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        Ok(meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(meta.file_type().is_symlink())
    }
}

pub fn assert_no_reparse_ancestors(path: &Path) -> io::Result<()> {
    let mut cur = Some(path);
    while let Some(p) = cur {
        if p.exists() && is_reparse_point(p)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("路径包含重解析点或符号链接：{}", p.display()),
            ));
        }
        cur = p.parent();
    }
    Ok(())
}

/// Recursively remove a directory while refusing to traverse or delete any reparse point / junction.
pub fn remove_dir_safe(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!("拒绝删除重解析点/联接点：{}", path.display()),
                    ));
                }
            }
            if !meta.is_dir() {
                return fs::remove_file(path);
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }

    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let child = entry.path();
        let meta = fs::symlink_metadata(&child)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("目录内存在重解析点/联接点，已中止清理：{}", child.display()),
                ));
            }
        }
        if meta.is_dir() {
            remove_dir_safe(&child)?;
        } else {
            fs::remove_file(&child)?;
        }
    }
    fs::remove_dir(path)
}

pub fn normalize_for_compare(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    s.trim_end_matches('\\').to_ascii_lowercase()
}

pub fn validate_install_dir(install_dir: &Path, state_root: &Path) -> Result<PathBuf, String> {
    if !install_dir.is_absolute() {
        return Err("安装目录必须是绝对路径".into());
    }
    let raw = install_dir.to_string_lossy();
    if raw.contains('"') || raw.contains('\r') || raw.contains('\n') || raw.starts_with("\\\\") {
        return Err("安装目录格式无效或不支持网络路径".into());
    }
    for comp in install_dir.components() {
        if matches!(comp, Component::ParentDir) {
            return Err("安装目录不允许包含 .. 路径穿越".into());
        }
    }
    if install_dir.parent().is_none() {
        return Err("不能将磁盘根目录作为安装目录".into());
    }
    let norm_install = normalize_for_compare(install_dir);
    let norm_state = normalize_for_compare(state_root);
    if norm_install == norm_state || norm_install.starts_with(&format!("{norm_state}\\")) {
        return Err("不能将用户数据目录作为安装目录".into());
    }
    if norm_state == norm_install || norm_state.starts_with(&format!("{norm_install}\\")) {
        return Err("用户数据目录不能位于安装目录内部".into());
    }
    if let Ok(win_dir) = std::env::var("WINDIR") {
        let norm_win = normalize_for_compare(Path::new(&win_dir));
        if norm_install == norm_win || norm_install.starts_with(&format!("{norm_win}\\")) {
            return Err("不能安装到 Windows 系统目录".into());
        }
    }
    assert_no_reparse_ancestors(install_dir).map_err(|e| e.to_string())?;
    Ok(install_dir.to_path_buf())
}

pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
pub fn update_in_progress() -> io::Result<bool> {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn GetLastError() -> u32;
    }
    let name = to_wide(UPDATE_ACTIVE_EVENT);
    let handle = unsafe { OpenEventW(0x00100000, 0, name.as_ptr()) };
    if handle == 0 {
        let err = unsafe { GetLastError() };
        return if err == 2 {
            Ok(false)
        } else {
            Err(io::Error::from_raw_os_error(err as i32))
        };
    }
    unsafe { CloseHandle(handle) };
    Ok(true)
}

#[cfg(windows)]
pub fn focus_update_window() -> bool {
    #[repr(C)]
    struct FlashInfo {
        size: u32,
        window: isize,
        flags: u32,
        count: u32,
        timeout: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> isize;
        fn ShowWindowAsync(hwnd: isize, command: i32) -> i32;
        fn SetForegroundWindow(hwnd: isize) -> i32;
        fn FlashWindowEx(info: *const FlashInfo) -> i32;
    }
    let title = to_wide(UPDATE_WINDOW_TITLE);
    let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if hwnd == 0 {
        return false;
    }
    unsafe {
        ShowWindowAsync(hwnd, 9);
        if SetForegroundWindow(hwnd) != 0 {
            return true;
        }
        FlashWindowEx(&FlashInfo {
            size: std::mem::size_of::<FlashInfo>() as u32,
            window: hwnd,
            flags: 2,
            count: 3,
            timeout: 0,
        });
    }
    false
}
