//! The native host selects the installation and opens the managed upstream launcher.
use crate::{cs2_activity, gsi_script, managed_cs2, powershell, production_exit, startup_log::DesktopLog, updates};
use std::{path::{Path, PathBuf}, sync::Mutex, time::Duration};
use tauri::Manager;
use crate::ShellExecuteW;

pub fn launch(app: &tauri::AppHandle, log: &DesktopLog) -> Result<(), String> {
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    let managed = app.state::<Mutex<managed_cs2::ManagedCs2>>();
    let no_game = || -> Result<(), String> {
        let cs2 = managed.try_lock().map_err(|_| "CS2 正忙，请稍后重试。")?;
        let status = cs2.mulnx_handoff_status()?;
        if !status["processes"].as_array().is_some_and(|processes| processes.is_empty()) {
            return Err("请先退出 CS2，再通过 MulNX 启动。".into());
        }
        Ok(())
    };
    no_game()?;
    let activity = app.state::<cs2_activity::Activity>();
    let _activity = activity.begin(3);
    let output = gsi_script("gsi-status.ps1", None, Duration::from_secs(20), log)?;
    let gsi = powershell::parse(log, "MulNX 游戏安装位置", &output)?;
    if gsi["detected"] != true || gsi["installed"] != true || gsi["conflict"] != false || gsi["readFailed"] != false {
        return Err("请先完成 CS2 的 GSI 配置。".into());
    }
    let cfg = PathBuf::from(gsi["cfgPath"].as_str().ok_or("CS2 安装位置未确认。")?);
    let executable = cfg.parent().and_then(Path::parent).and_then(Path::parent)
        .ok_or("CS2 安装位置无效。")?.join("bin/win64/cs2.exe");
    if !executable.is_file() { return Err("所选 CS2 程序不存在。".into()); }
    let prepared = production_exit::prepare_mulnx(log, &executable)?;
    let launcher = PathBuf::from(prepared["launcher"].as_str().ok_or("MulNX 启动路径缺失。")?);
    let root = log.state_root.join("data/mulnx").canonicalize().map_err(|e| format!("MulNX 目录无法读取：{e}"))?;
    let launcher = launcher.canonicalize().map_err(|e| format!("MulNX 程序无法读取：{e}"))?;
    if !launcher.starts_with(&root) || launcher.file_name().and_then(|s| s.to_str()) != Some("CS2Injector.exe") {
        return Err("MulNX 启动路径无效。".into());
    }
    app.state::<production_exit::ExitGate>().check()?;
    app.state::<updates::PendingUpdate>().check()?;
    no_game()?;
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = format!("{}\0", launcher.display()).encode_utf16().collect();
    let directory: Vec<u16> = format!("{}\0", launcher.parent().ok_or("MulNX 目录无效。")?.display()).encode_utf16().collect();
    let result = unsafe { ShellExecuteW(0, verb.as_ptr(), target.as_ptr(), std::ptr::null(), directory.as_ptr(), 1) };
    if result <= 32 { return Err(format!("MulNX 未能打开（系统代码 {result}）。")); }
    log.event("mulnx_launch", "success", Some(&format!("version={}", prepared["version"])));
    Ok(())
}
