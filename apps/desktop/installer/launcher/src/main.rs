#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mizar_common::{
    focus_update_window, read_current_pointer, to_wide, update_in_progress, version_id_semver,
};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn show_error_box(msg: &str) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
        }
        let text = to_wide(msg);
        let caption = to_wide("Mizar 启动失败");
        unsafe {
            MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{msg}");
}

fn resolve_target_exe(root: &Path) -> Option<PathBuf> {
    if let Some(ptr) = read_current_pointer(root) {
        let candidate = root.join("versions").join(&ptr.current).join("Mizar.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // Read-only fallback: pick highest semver version in versions/ that has Mizar.exe + installed.flag
    let versions_dir = root.join("versions");
    let entries = fs::read_dir(&versions_dir).ok()?;
    let mut best: Option<((u64, u64, u64), PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(semver) = version_id_semver(&name) else {
            continue;
        };
        let exe = path.join("Mizar.exe");
        let flag = path.join("installed.flag");
        if exe.is_file() && flag.is_file() {
            if best.as_ref().is_none_or(|(b_ver, _)| semver > *b_ver) {
                best = Some((semver, exe));
            }
        }
    }
    best.map(|(_, exe)| exe)
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let has_flag = |flag: &str| args.iter().any(|a| a == flag);
    let is_stop = has_flag("--stop");
    let is_app_version = has_flag("--app-version");
    let is_headless = has_flag("--no-browser");
    let is_synchronous = is_stop || is_app_version || is_headless || has_flag("--export-logs");

    if !is_stop && !is_app_version {
        #[cfg(windows)]
        if let Ok(true) = update_in_progress() {
            focus_update_window();
            std::process::exit(1);
        }
    }

    let Ok(exe_path) = std::env::current_exe() else {
        if !is_headless && !is_stop && !is_app_version {
            show_error_box("无法定位 Mizar 安装目录。");
        }
        std::process::exit(1);
    };
    let Some(root) = exe_path.parent() else {
        std::process::exit(1);
    };

    let Some(target) = resolve_target_exe(root) else {
        if !is_headless && !is_stop && !is_app_version {
            show_error_box("程序文件不完整，请下载官方安装包覆盖修复（用户资料已保留）。");
        } else {
            eprintln!("程序文件不完整，请下载官方安装包覆盖修复（用户资料已保留）。");
        }
        std::process::exit(1);
    };

    let mut cmd = Command::new(&target);
    cmd.args(&args);
    if is_synchronous {
        cmd.stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        match cmd.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(err) => {
                eprintln!("无法启动 Mizar：{err}");
                std::process::exit(1);
            }
        }
    } else {
        match cmd.spawn() {
            Ok(_) => std::process::exit(0),
            Err(err) => {
                show_error_box(&format!("无法启动 Mizar：{err}"));
                std::process::exit(1);
            }
        }
    }
}
