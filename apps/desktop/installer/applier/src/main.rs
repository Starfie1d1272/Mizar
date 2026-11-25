#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod payload;
mod ui;
mod win32;

use cli::{parse_args, write_result, ApplierResult, CommandMode, ExitCode};
use mizar_common::{
    is_reparse_point, read_current_pointer, remove_dir_safe, replace_file_atomic,
    validate_install_dir, write_current_pointer_atomic, CurrentPointer,
};
use payload::{move_or_copy_dir, prepare_core_resources, sha256_file, verify_payload};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use ui::ProgressUi;
use win32::{
    clear_legacy_run_once, create_shortcut, delete_install_registry, desktop_dir,
    find_running_mizar_under, launch_and_wait_ready, random_hex_16, remove_shortcuts,
    schedule_self_delete, start_menu_dir, utc_compact_timestamp, utc_iso8601, wait_host_exit,
    write_install_registry, DesktopMutexHandle, LaunchOutcome, UpdateActiveEvent, WriterMutex,
};

struct Logger {
    path: PathBuf,
    file: Mutex<Option<File>>,
}

impl Logger {
    fn new(state_root: &Path) -> Self {
        let logs_dir = state_root.join("logs");
        let _ = fs::create_dir_all(&logs_dir);
        let path = logs_dir.join(format!("applier-{}.log", utc_compact_timestamp()));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self {
            path,
            file: Mutex::new(file),
        }
    }

    fn log(&self, msg: &str) {
        let line = format!("[{}] {msg}\n", utc_iso8601());
        eprint!("{line}");
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = f.write_all(line.as_bytes());
                let _ = f.flush();
            }
        }
    }
}

fn default_state_root() -> Result<PathBuf, String> {
    if let Some(v) = std::env::var_os("MIZAR_STATE_ROOT") {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return Ok(p);
        }
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "无法读取 LOCALAPPDATA 环境变量".to_string())?;
    Ok(PathBuf::from(local).join("Mizar"))
}

fn copy_binary_with_retry(src: &Path, dst: &Path) -> Result<(), String> {
    if let Ok(dst_hash) = sha256_file(dst) {
        if let Ok(src_hash) = sha256_file(src) {
            if dst_hash == src_hash {
                return Ok(());
            }
        }
    }
    let tmp = dst.with_extension(format!("exe.{}.tmp", std::process::id()));
    fs::copy(src, &tmp).map_err(|e| format!("复制 {} 失败: {e}", dst.display()))?;
    for attempt in 0..5 {
        match replace_file_atomic(&tmp, dst) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 => {
                let _ = e;
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("替换 {} 失败: {e}", dst.display()));
            }
        }
    }
    Ok(())
}

fn retire_legacy_update_state(state_root: &Path, log: &Logger) {
    clear_legacy_run_once();
    let ts = utc_compact_timestamp();
    let pending = state_root.join("bootstrap-cache/fresh-install.pending");
    if pending.exists() {
        let dest = state_root.join(format!("bootstrap-cache/fresh-install.pending.retired-{ts}"));
        if let Err(e) = fs::rename(&pending, &dest) {
            log.log(&format!("warn: retire fresh-install.pending failed: {e}"));
        }
    }
    let updates_dir = state_root.join("updates");
    if let Ok(entries) = fs::read_dir(&updates_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if s.starts_with("install-") && !s.contains(".retired-") {
                let dest = updates_dir.join(format!("{s}.retired-{ts}"));
                if let Err(e) = fs::rename(entry.path(), &dest) {
                    log.log(&format!("warn: retire {s} failed: {e}"));
                }
            }
        }
    }
}

fn relaunch_existing_mizar(install_dir: &Path, log: &Logger) {
    let exe = install_dir.join("Mizar.exe");
    if exe.is_file() {
        log.log(&format!("relaunching existing Mizar: {}", exe.display()));
        let _ = Command::new(&exe)
            .current_dir(install_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

struct InstallParams {
    payload_dir: PathBuf,
    install_dir: PathBuf,
    state_root: PathBuf,
    expected_content_digest: Option<String>,
    core_archive_sha256: Option<String>,
    installer_sha256: Option<String>,
    installer_bytes: Option<u64>,
    desktop_shortcut: bool,
    no_ui: bool,
    no_launch: bool,
    result_file: Option<PathBuf>,
    apply_update: Option<(u32, u64, Option<usize>)>,
}

fn run_install_or_update(params: InstallParams, log: &Logger) -> (ExitCode, ApplierResult) {
    let mut version_out: Option<String> = None;
    let mut prev_version_out: Option<String> = None;
    let mut cleanup_warning: Option<String> = None;

    let make_result = |code: ExitCode,
                       ver: Option<String>,
                       prev: Option<String>,
                       warn: Option<String>,
                       msg: Option<String>| ApplierResult {
        status: code.status_str(),
        code: code.code_str(),
        version: ver,
        previous_version: prev,
        cleanup_warning: warn,
        log_path: log.path.to_string_lossy().into_owned(),
        message: msg,
    };

    // Phase 1: Acquire & UI
    let _writer = match WriterMutex::try_acquire() {
        Ok(Some(w)) => w,
        Ok(None) => {
            let msg = "另一个 Mizar 安装或更新事务正在进行中".to_string();
            log.log(&msg);
            return (ExitCode::WriterBusy, make_result(ExitCode::WriterBusy, None, None, None, Some(msg)));
        }
        Err(e) => {
            let msg = format!("无法获取全局写入锁: {e}");
            log.log(&msg);
            return (ExitCode::IoError, make_result(ExitCode::IoError, None, None, None, Some(msg)));
        }
    };

    let active_event = match UpdateActiveEvent::acquire() {
        Ok(ev) => Some(ev),
        Err(e) => {
            log.log(&format!("warn: UpdateActiveEvent failed: {e}"));
            None
        }
    };

    let mut desktop_mutex = match &params.apply_update {
        Some((_, _, Some(raw))) => DesktopMutexHandle::from_raw(*raw),
        _ => match DesktopMutexHandle::acquire_or_create() {
            Ok(m) => m,
            Err(e) => {
                let msg = format!("无法获取桌面互斥锁: {e}");
                log.log(&msg);
                return (ExitCode::IoError, make_result(ExitCode::IoError, None, None, None, Some(msg)));
            }
        },
    };

    let ui = ProgressUi::start(params.no_ui, "正在校验安装包...");

    // Helper for pre-commit failure in apply-update: release locks & relaunch old Mizar
    let recover_old_on_precommit_fail = |mut dm: DesktopMutexHandle, ae: Option<UpdateActiveEvent>| {
        dm.release_now();
        drop(ae);
        if params.apply_update.is_some() {
            relaunch_existing_mizar(&params.install_dir, log);
        }
    };

    // Phase 2: Stage (completely reversible, cancellable)
    let install_dir = match validate_install_dir(&params.install_dir, &params.state_root) {
        Ok(p) => p,
        Err(msg) => {
            log.log(&msg);
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::IoError, make_result(ExitCode::IoError, None, None, None, Some(msg)));
        }
    };

    let artifact = match verify_payload(
        &params.payload_dir,
        params.expected_content_digest.as_deref(),
        &|| ui.is_cancelled(),
    ) {
        Ok(a) => a,
        Err(e) if e == "cancelled" => {
            log.log("cancelled during payload verification");
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::Cancelled, make_result(ExitCode::Cancelled, None, None, None, Some("用户取消安装".into())));
        }
        Err(msg) => {
            log.log(&format!("payload verification failed: {msg}"));
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::PayloadInvalid, make_result(ExitCode::PayloadInvalid, None, None, None, Some(msg)));
        }
    };
    version_out = Some(artifact.app_version.clone());
    log.log(&format!(
        "verified payload: version={} gitSha={} mode={}",
        artifact.app_version, artifact.git_sha, artifact.resource_mode
    ));

    if ui.is_cancelled() {
        ui.close();
        recover_old_on_precommit_fail(desktop_mutex, active_event);
        return (ExitCode::Cancelled, make_result(ExitCode::Cancelled, version_out, None, None, Some("用户取消安装".into())));
    }

    let is_legacy_layout = (install_dir.join("installed.flag").exists()
        || install_dir.join("resources/metadata/artifact.json").exists())
        && !install_dir.join("current.json").exists();

    let mut version_id = format!("{}-{}", artifact.app_version, &artifact.git_sha[..8]);
    if !is_legacy_layout && install_dir.join("versions").join(&version_id).exists() {
        let nonce6 = &random_hex_16()[..6];
        version_id = format!("{version_id}-{nonce6}");
    }

    let staging_dir = if is_legacy_layout {
        let parent = install_dir.parent().unwrap_or(&install_dir);
        parent.join(format!(
            "{}.mizar-staging-{}",
            install_dir.file_name().unwrap_or_default().to_string_lossy(),
            &random_hex_16()[..8]
        ))
    } else {
        install_dir.join("staging").join(&version_id)
    };

    ui.set_stage("正在准备版本文件...");
    if staging_dir.exists() {
        let _ = remove_dir_safe(&staging_dir);
    }
    if let Err(e) = move_or_copy_dir(&params.payload_dir, &staging_dir) {
        let msg = format!("暂存新版本文件失败: {e}");
        log.log(&msg);
        let _ = remove_dir_safe(&staging_dir);
        ui.close();
        recover_old_on_precommit_fail(desktop_mutex, active_event);
        return (ExitCode::IoError, make_result(ExitCode::IoError, version_out, None, None, Some(msg)));
    }
    if let Err(e) = fs::write(staging_dir.join("installed.flag"), b"mizar.install.v2\n") {
        let msg = format!("写入 installed.flag 失败: {e}");
        log.log(&msg);
        let _ = remove_dir_safe(&staging_dir);
        ui.close();
        recover_old_on_precommit_fail(desktop_mutex, active_event);
        return (ExitCode::IoError, make_result(ExitCode::IoError, version_out, None, None, Some(msg)));
    }

    // Phase 3: Quiesce
    ui.set_stage("正在等待旧版程序退出...");
    if let Some((host_pid, host_start_time, _)) = params.apply_update {
        if let Err(msg) = wait_host_exit(host_pid, host_start_time, Duration::from_secs(60)) {
            log.log(&msg);
            let _ = remove_dir_safe(&staging_dir);
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::AppRunning, make_result(ExitCode::AppRunning, version_out, None, None, Some(msg)));
        }
    } else if find_running_mizar_under(&install_dir) {
        let msg = "检测到当前目录的 Mizar 仍在运行，请先退出后再安装".to_string();
        log.log(&msg);
        let _ = remove_dir_safe(&staging_dir);
        ui.close();
        return (ExitCode::AppRunning, make_result(ExitCode::AppRunning, version_out, None, None, Some(msg)));
    }

    if ui.is_cancelled() {
        let _ = remove_dir_safe(&staging_dir);
        ui.close();
        recover_old_on_precommit_fail(desktop_mutex, active_event);
        return (ExitCode::Cancelled, make_result(ExitCode::Cancelled, version_out, None, None, Some("用户取消安装".into())));
    }

    if artifact.resource_mode == "core" {
        ui.set_stage("正在准备官方素材包...");
        match prepare_core_resources(
            &staging_dir,
            &params.state_root,
            &artifact,
            params.core_archive_sha256.as_deref(),
            params.installer_sha256.as_deref(),
            params.installer_bytes,
        ) {
            Ok(out) => log.log(&format!("core resources ready: {out}")),
            Err(msg) => {
                log.log(&msg);
                let _ = remove_dir_safe(&staging_dir);
                ui.close();
                recover_old_on_precommit_fail(desktop_mutex, active_event);
                return (ExitCode::ResourcesFailed, make_result(ExitCode::ResourcesFailed, version_out, None, None, Some(msg)));
            }
        }
    }

    if ui.is_cancelled() {
        let _ = remove_dir_safe(&staging_dir);
        ui.close();
        recover_old_on_precommit_fail(desktop_mutex, active_event);
        return (ExitCode::Cancelled, make_result(ExitCode::Cancelled, version_out, None, None, Some("用户取消安装".into())));
    }

    // Phase 4: Switch & Commit (atomic commit point, cancel disabled)
    ui.enter_commit();
    ui.set_stage("正在切换版本...");

    let old_pointer = read_current_pointer(&install_dir);
    prev_version_out = old_pointer.as_ref().map(|p| {
        p.current
            .split('-')
            .next()
            .unwrap_or(&p.current)
            .to_owned()
    });

    if is_legacy_layout {
        let legacy_archive = install_dir.with_file_name(format!(
            "{}-legacy-{}",
            install_dir.file_name().unwrap_or_default().to_string_lossy(),
            utc_compact_timestamp()
        ));
        log.log(&format!("archiving legacy dir to {}", legacy_archive.display()));
        if let Err(e) = fs::rename(&install_dir, &legacy_archive) {
            let msg = format!("归档旧安装目录失败: {e}");
            log.log(&msg);
            let _ = remove_dir_safe(&staging_dir);
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::IoError, make_result(ExitCode::IoError, version_out, prev_version_out, None, Some(msg)));
        }
        let target_ver_dir = install_dir.join("versions").join(&version_id);
        if let Err(e) = fs::create_dir_all(install_dir.join("versions"))
            .and_then(|_| move_or_copy_dir(&staging_dir, &target_ver_dir))
        {
            let msg = format!("重建安装目录失败，已回退旧目录: {e}");
            log.log(&msg);
            let _ = remove_dir_safe(&install_dir);
            let _ = fs::rename(&legacy_archive, &install_dir);
            let _ = remove_dir_safe(&staging_dir);
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::IoError, make_result(ExitCode::IoError, version_out, prev_version_out, None, Some(msg)));
        }
        retire_legacy_update_state(&params.state_root, log);
    } else {
        let target_ver_dir = install_dir.join("versions").join(&version_id);
        if let Err(e) = fs::create_dir_all(install_dir.join("versions"))
            .and_then(|_| move_or_copy_dir(&staging_dir, &target_ver_dir))
        {
            let msg = format!("移动版本目录失败: {e}");
            log.log(&msg);
            let _ = remove_dir_safe(&staging_dir);
            ui.close();
            recover_old_on_precommit_fail(desktop_mutex, active_event);
            return (ExitCode::IoError, make_result(ExitCode::IoError, version_out, prev_version_out, None, Some(msg)));
        }
    }

    let ver_dir = install_dir.join("versions").join(&version_id);
    if let Err(warn) = copy_binary_with_retry(&ver_dir.join("mizar-launcher.exe"), &install_dir.join("Mizar.exe")) {
        log.log(&format!("warn: {warn}"));
        cleanup_warning = Some(warn);
    }
    if let Err(warn) = copy_binary_with_retry(&ver_dir.join("mizar-applier.exe"), &install_dir.join("Uninstall.exe")) {
        log.log(&format!("warn: {warn}"));
        if cleanup_warning.is_none() {
            cleanup_warning = Some(warn);
        }
    }

    let previous_id = old_pointer.as_ref().map(|p| p.current.clone());
    let new_pointer = CurrentPointer {
        schema_version: 2,
        current: version_id.clone(),
        previous: previous_id.clone(),
        updated_at: utc_iso8601(),
    };
    if let Err(e) = write_current_pointer_atomic(&install_dir, &new_pointer) {
        let msg = format!("写入 current.json 失败: {e}");
        log.log(&msg);
        ui.close();
        recover_old_on_precommit_fail(desktop_mutex, active_event);
        return (ExitCode::IoError, make_result(ExitCode::IoError, version_out, prev_version_out, cleanup_warning, Some(msg)));
    }
    log.log(&format!("committed current.json -> {version_id}"));

    if let Err(e) = write_install_registry(&install_dir, &params.state_root, &artifact.app_version) {
        log.log(&format!("warn: registry write failed: {e}"));
        if cleanup_warning.is_none() {
            cleanup_warning = Some(e);
        }
    }
    if let Some(sm) = start_menu_dir() {
        let _ = create_shortcut(&sm.join("Mizar.lnk"), &install_dir.join("Mizar.exe"), &install_dir);
        let _ = create_shortcut(&sm.join("卸载 Mizar.lnk"), &install_dir.join("Uninstall.exe"), &install_dir);
    }
    if params.desktop_shortcut {
        if let Some(desktop) = desktop_dir() {
            let _ = create_shortcut(&desktop.join("Mizar.lnk"), &install_dir.join("Mizar.exe"), &install_dir);
        }
    }

    // Phase 5: Post (release locks, launch & verify, best-effort cleanup)
    desktop_mutex.release_now();
    drop(active_event);

    let mut final_code = ExitCode::Ok;
    if !params.no_launch {
        ui.set_stage("正在启动新版 Mizar...");
        let target_exe = ver_dir.join("Mizar.exe");
        match launch_and_wait_ready(&target_exe, Duration::from_secs(60)) {
            Ok(LaunchOutcome::Ready) => {
                log.log("new version confirmed ready");
            }
            Ok(LaunchOutcome::Timeout) => {
                log.log("warn: launch readiness timed out after 60s, keeping new version");
            }
            Ok(LaunchOutcome::ExitedEarly(code)) => {
                log.log(&format!("new version exited early (code={code:?})"));
                if let Some(prev_id) = &previous_id {
                    let prev_exe = install_dir.join("versions").join(prev_id).join("Mizar.exe");
                    if prev_exe.is_file() {
                        let rollback_ptr = CurrentPointer {
                            schema_version: 2,
                            current: prev_id.clone(),
                            previous: None,
                            updated_at: utc_iso8601(),
                        };
                        if let Err(e) = write_current_pointer_atomic(&install_dir, &rollback_ptr) {
                            log.log(&format!("rollback current.json failed: {e}"));
                        } else {
                            log.log(&format!("rolled back current.json -> {prev_id}"));
                            let _ = Command::new(&prev_exe)
                                .current_dir(prev_exe.parent().unwrap_or(&install_dir))
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .spawn();
                            final_code = ExitCode::RolledBack;
                        }
                    }
                }
            }
            Err(e) => {
                log.log(&format!("launch failed: {e}"));
            }
        }
    }

    // Best-effort delayed cleanup of older versions & staging
    if final_code == ExitCode::Ok {
        let versions_dir = install_dir.join("versions");
        if let Ok(entries) = fs::read_dir(&versions_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                let keep = name_str == version_id
                    || previous_id.as_deref() == Some(name_str.as_ref());
                if !keep {
                    let p = entry.path();
                    if let Err(e) = remove_dir_safe(&p) {
                        let w = format!("清理旧版本 {} 失败: {e}", name_str);
                        log.log(&format!("warn: {w}"));
                        if cleanup_warning.is_none() {
                            cleanup_warning = Some(w);
                        }
                    }
                }
            }
        }
        let staging_root = install_dir.join("staging");
        if staging_root.exists() {
            if let Err(e) = remove_dir_safe(&staging_root) {
                let w = format!("清理 staging 失败: {e}");
                log.log(&format!("warn: {w}"));
                if cleanup_warning.is_none() {
                    cleanup_warning = Some(w);
                }
            }
        }
    }

    ui.close();
    let msg = if final_code == ExitCode::RolledBack {
        Some("新版启动失败，已自动回退到上一版本".into())
    } else {
        None
    };
    (
        final_code,
        make_result(final_code, version_out, prev_version_out, cleanup_warning, msg),
    )
}

fn run_uninstall(
    install_dir: PathBuf,
    state_root: PathBuf,
    no_ui: bool,
    log: &Logger,
) -> (ExitCode, ApplierResult) {
    let make_result = |code: ExitCode, warn: Option<String>, msg: Option<String>| ApplierResult {
        status: code.status_str(),
        code: code.code_str(),
        version: None,
        previous_version: None,
        cleanup_warning: warn,
        log_path: log.path.to_string_lossy().into_owned(),
        message: msg,
    };

    let _writer = match WriterMutex::try_acquire() {
        Ok(Some(w)) => w,
        Ok(None) => {
            return (
                ExitCode::WriterBusy,
                make_result(ExitCode::WriterBusy, None, Some("另一个安装或更新事务正在进行中".into())),
            );
        }
        Err(e) => {
            return (
                ExitCode::IoError,
                make_result(ExitCode::IoError, None, Some(format!("无法获取写入锁: {e}"))),
            );
        }
    };
    let _active = UpdateActiveEvent::acquire().ok();

    if find_running_mizar_under(&install_dir) {
        return (
            ExitCode::AppRunning,
            make_result(ExitCode::AppRunning, None, Some("请先正常退出 Mizar 后再卸载".into())),
        );
    }

    let ui = ProgressUi::start(no_ui, "正在卸载 Mizar...");
    ui.enter_commit();

    if let Ok(true) = is_reparse_point(&install_dir) {
        ui.close();
        return (
            ExitCode::IoError,
            make_result(ExitCode::IoError, None, Some("安装目录是重解析点，拒绝卸载删除".into())),
        );
    }

    remove_shortcuts();
    delete_install_registry();

    let mut warn: Option<String> = None;
    for sub in ["versions", "staging"] {
        let p = install_dir.join(sub);
        if p.exists() {
            if let Err(e) = remove_dir_safe(&p) {
                let w = format!("清理 {sub} 失败: {e}");
                log.log(&w);
                warn = Some(w);
            }
        }
    }
    for file in ["current.json", "Mizar.exe", "installed.flag"] {
        let p = install_dir.join(file);
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
    }

    // If we are running as <install_dir>/Uninstall.exe, schedule self-delete
    if let Ok(cur_exe) = std::env::current_exe() {
        if cur_exe.parent() == Some(install_dir.as_path()) {
            schedule_self_delete(&cur_exe, &install_dir);
        } else {
            let uninst = install_dir.join("Uninstall.exe");
            if uninst.exists() {
                let _ = fs::remove_file(&uninst);
            }
            let _ = fs::remove_dir(&install_dir);
        }
    }

    let _ = state_root; // Explicitly never delete user data under %LOCALAPPDATA%\Mizar
    ui.close();
    (ExitCode::Ok, make_result(ExitCode::Ok, warn, None))
}

fn main() {
    let mode = match parse_args() {
        Ok(m) => m,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(ExitCode::InternalError as i32);
        }
    };

    let state_override = match &mode {
        CommandMode::Install { state_root, .. }
        | CommandMode::ApplyUpdate { state_root, .. }
        | CommandMode::Uninstall { state_root, .. } => state_root.clone(),
    };
    let state_root = match state_override.map(Ok).unwrap_or_else(default_state_root) {
        Ok(p) => p,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(ExitCode::IoError as i32);
        }
    };
    let log = Logger::new(&state_root);

    let (result_file, code, result) = match mode {
        CommandMode::Install {
            payload_dir,
            install_dir,
            expected_content_digest,
            core_archive_sha256,
            installer_sha256,
            installer_bytes,
            desktop_shortcut,
            no_ui,
            no_launch,
            result_file,
            ..
        } => {
            let (c, r) = run_install_or_update(
                InstallParams {
                    payload_dir,
                    install_dir,
                    state_root: state_root.clone(),
                    expected_content_digest,
                    core_archive_sha256,
                    installer_sha256,
                    installer_bytes,
                    desktop_shortcut,
                    no_ui,
                    no_launch,
                    result_file: result_file.clone(),
                    apply_update: None,
                },
                &log,
            );
            (result_file, c, r)
        }
        CommandMode::ApplyUpdate {
            payload_dir,
            install_dir,
            expected_content_digest,
            core_archive_sha256,
            installer_sha256,
            installer_bytes,
            host_pid,
            host_start_time,
            desktop_mutex_handle,
            no_ui,
            result_file,
            ..
        } => {
            let (c, r) = run_install_or_update(
                InstallParams {
                    payload_dir,
                    install_dir,
                    state_root: state_root.clone(),
                    expected_content_digest: Some(expected_content_digest),
                    core_archive_sha256,
                    installer_sha256,
                    installer_bytes,
                    desktop_shortcut: false,
                    no_ui,
                    no_launch: false,
                    result_file: result_file.clone(),
                    apply_update: Some((host_pid, host_start_time, desktop_mutex_handle)),
                },
                &log,
            );
            (result_file, c, r)
        }
        CommandMode::Uninstall {
            install_dir,
            no_ui,
            result_file,
            ..
        } => {
            let (c, r) = run_uninstall(install_dir, state_root.clone(), no_ui, &log);
            (result_file, c, r)
        }
    };

    write_result(&result, result_file.as_deref(), &state_root);
    std::process::exit(code as i32);
}
