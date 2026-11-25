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
use payload::{move_or_copy_dir, sha256_file, verify_payload};
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
    schedule_dir_delete, schedule_self_delete, show_message_box, start_menu_dir,
    utc_compact_timestamp, utc_iso8601, wait_host_exit, write_install_registry, DesktopMutexHandle,
    LaunchOutcome, UpdateActiveEvent, WriterMutex,
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

struct StepError {
    code: ExitCode,
    msg: String,
}

impl StepError {
    fn new(code: ExitCode, msg: impl Into<String>) -> Self {
        Self {
            code,
            msg: msg.into(),
        }
    }
}

struct StagingGuard(Option<PathBuf>);
impl Drop for StagingGuard {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = remove_dir_safe(&p);
        }
    }
}

struct LegacyArchiveGuard {
    install_dir: PathBuf,
    archive: Option<PathBuf>,
}
impl Drop for LegacyArchiveGuard {
    fn drop(&mut self) {
        if let Some(arch) = self.archive.take() {
            let _ = remove_dir_safe(&self.install_dir);
            let _ = fs::rename(&arch, &self.install_dir);
        }
    }
}

struct PreCommitGuard {
    desktop_mutex: Option<DesktopMutexHandle>,
    active_event: Option<UpdateActiveEvent>,
    relaunch_dir: Option<PathBuf>,
}
impl PreCommitGuard {
    fn release_locks(&mut self) {
        self.relaunch_dir = None;
        if let Some(mut dm) = self.desktop_mutex.take() {
            dm.release_now();
        }
        self.active_event.take();
    }
}
impl Drop for PreCommitGuard {
    fn drop(&mut self) {
        if let Some(mut dm) = self.desktop_mutex.take() {
            dm.release_now();
        }
        self.active_event.take();
        if let Some(dir) = self.relaunch_dir.take() {
            let exe = dir.join("Mizar.exe");
            if exe.is_file() {
                let _ = Command::new(&exe)
                    .current_dir(&dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
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
    if let (Ok(dst_hash), Ok(src_hash)) = (sha256_file(dst), sha256_file(src)) {
        if dst_hash == src_hash {
            return Ok(());
        }
    }
    let tmp = dst.with_extension(format!("exe.{}.tmp", std::process::id()));
    fs::copy(src, &tmp).map_err(|e| format!("复制 {} 失败: {e}", dst.display()))?;
    for attempt in 0..5 {
        match replace_file_atomic(&tmp, dst) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 4 => std::thread::sleep(Duration::from_millis(200)),
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
        let dest = state_root.join(format!(
            "bootstrap-cache/fresh-install.pending.retired-{ts}"
        ));
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

struct InstallParams {
    payload_dir: PathBuf,
    install_dir: PathBuf,
    state_root: PathBuf,
    expected_content_digest: Option<String>,
    desktop_shortcut: bool,
    no_ui: bool,
    no_launch: bool,
    apply_update: Option<(u32, u64, Option<usize>)>,
}

fn run_install_or_update(params: InstallParams, log: &Logger) -> (ExitCode, ApplierResult) {
    let mut version_out: Option<String> = None;
    let mut prev_version_out: Option<String> = None;
    let mut cleanup_warning: Option<String> = None;

    let res = execute_install_or_update(
        &params,
        log,
        &mut version_out,
        &mut prev_version_out,
        &mut cleanup_warning,
    );

    if params.apply_update.is_some() {
        schedule_dir_delete(&params.payload_dir);
    }

    let (code, msg) = match res {
        Ok(()) => (ExitCode::Ok, None),
        Err(e) => {
            log.log(&e.msg);
            (e.code, Some(e.msg))
        }
    };
    (
        code,
        ApplierResult {
            status: code.status_str(),
            code: code.code_str(),
            version: version_out,
            previous_version: prev_version_out,
            cleanup_warning,
            log_path: log.path.to_string_lossy().into_owned(),
            message: msg,
        },
    )
}

fn execute_install_or_update(
    params: &InstallParams,
    log: &Logger,
    version_out: &mut Option<String>,
    prev_version_out: &mut Option<String>,
    cleanup_warning: &mut Option<String>,
) -> Result<(), StepError> {
    // Phase 1: Acquire & UI
    let _writer = WriterMutex::try_acquire()
        .map_err(|e| StepError::new(ExitCode::IoError, format!("无法获取全局写入锁: {e}")))?
        .ok_or_else(|| {
            StepError::new(
                ExitCode::WriterBusy,
                "另一个 Mizar 安装或更新事务正在进行中",
            )
        })?;

    let active_event = match UpdateActiveEvent::acquire() {
        Ok(ev) => Some(ev),
        Err(e) => {
            log.log(&format!("warn: UpdateActiveEvent failed: {e}"));
            None
        }
    };

    let desktop_mutex = match &params.apply_update {
        Some((_, _, Some(raw))) => DesktopMutexHandle::from_raw(*raw),
        _ => DesktopMutexHandle::acquire_or_create()
            .map_err(|e| StepError::new(ExitCode::IoError, format!("无法获取桌面互斥锁: {e}")))?,
    };

    let mut guards = PreCommitGuard {
        desktop_mutex: Some(desktop_mutex),
        active_event,
        relaunch_dir: params
            .apply_update
            .as_ref()
            .map(|_| params.install_dir.clone()),
    };

    let ui = ProgressUi::start(params.no_ui, "正在校验安装包...");

    // Phase 2: Stage (completely reversible, cancellable)
    let install_dir = validate_install_dir(&params.install_dir, &params.state_root)
        .map_err(|m| StepError::new(ExitCode::IoError, m))?;

    let artifact = verify_payload(
        &params.payload_dir,
        params.expected_content_digest.as_deref(),
        &|| ui.is_cancelled(),
    )
    .map_err(|msg| {
        if msg == "cancelled" {
            StepError::new(ExitCode::Cancelled, "用户取消安装")
        } else {
            StepError::new(ExitCode::PayloadInvalid, msg)
        }
    })?;

    *version_out = Some(artifact.app_version.clone());
    log.log(&format!(
        "verified payload: version={} gitSha={} mode={}",
        artifact.app_version, artifact.git_sha, artifact.resource_mode
    ));

    if ui.is_cancelled() {
        return Err(StepError::new(ExitCode::Cancelled, "用户取消安装"));
    }

    let is_legacy_layout = (install_dir.join("installed.flag").exists()
        || install_dir
            .join("resources/metadata/artifact.json")
            .exists())
        && !install_dir.join("current.json").exists();

    let mut version_id = format!("{}-{}", artifact.app_version, &artifact.git_sha[..8]);
    if !is_legacy_layout && install_dir.join("versions").join(&version_id).exists() {
        version_id = format!("{version_id}-{}", &random_hex_16()[..6]);
    }

    let staging_dir = if is_legacy_layout {
        let parent = install_dir.parent().unwrap_or(&install_dir);
        parent.join(format!(
            "{}.mizar-staging-{}",
            install_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            &random_hex_16()[..8]
        ))
    } else {
        install_dir.join("staging").join(&version_id)
    };

    ui.set_stage("正在准备版本文件...");
    if staging_dir.exists() {
        let _ = remove_dir_safe(&staging_dir);
    }
    let mut staging_guard = StagingGuard(Some(staging_dir.clone()));

    move_or_copy_dir(&params.payload_dir, &staging_dir)
        .map_err(|e| StepError::new(ExitCode::IoError, format!("暂存新版本文件失败: {e}")))?;
    fs::write(staging_dir.join("installed.flag"), b"mizar.install.v2\n")
        .map_err(|e| StepError::new(ExitCode::IoError, format!("写入 installed.flag 失败: {e}")))?;

    // Phase 3: Quiesce
    ui.set_stage("正在等待旧版程序退出...");
    if let Some((host_pid, host_start_time, _)) = params.apply_update {
        wait_host_exit(host_pid, host_start_time, Duration::from_secs(60))
            .map_err(|m| StepError::new(ExitCode::AppRunning, m))?;
    } else if find_running_mizar_under(&install_dir) {
        return Err(StepError::new(
            ExitCode::AppRunning,
            "检测到当前目录的 Mizar 仍在运行，请先退出后再安装",
        ));
    }

    if ui.is_cancelled() {
        return Err(StepError::new(ExitCode::Cancelled, "用户取消安装"));
    }

    // Phase 4: Switch & Commit (atomic commit point, cancel disabled)
    ui.enter_commit();
    ui.set_stage("正在切换版本...");

    let old_pointer = read_current_pointer(&install_dir);
    *prev_version_out = old_pointer
        .as_ref()
        .map(|p| p.current.split('-').next().unwrap_or(&p.current).to_owned());

    let mut legacy_guard = LegacyArchiveGuard {
        install_dir: install_dir.clone(),
        archive: None,
    };
    if is_legacy_layout {
        let arch = install_dir.with_file_name(format!(
            "{}-legacy-{}",
            install_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            utc_compact_timestamp()
        ));
        log.log(&format!("archiving legacy dir to {}", arch.display()));
        fs::rename(&install_dir, &arch)
            .map_err(|e| StepError::new(ExitCode::IoError, format!("归档旧安装目录失败: {e}")))?;
        legacy_guard.archive = Some(arch);
    }

    let ver_dir = install_dir.join("versions").join(&version_id);
    fs::create_dir_all(install_dir.join("versions"))
        .and_then(|_| move_or_copy_dir(&staging_dir, &ver_dir))
        .map_err(|e| StepError::new(ExitCode::IoError, format!("移动版本目录失败: {e}")))?;
    staging_guard.0 = None;
    if legacy_guard.archive.is_some() {
        retire_legacy_update_state(&params.state_root, log);
    }

    for (src_name, dst_name) in [
        ("mizar-launcher.exe", "Mizar.exe"),
        ("mizar-applier.exe", "Uninstall.exe"),
    ] {
        let dst = install_dir.join(dst_name);
        let required = legacy_guard.archive.is_some() || !dst.is_file();
        if let Err(err) = copy_binary_with_retry(&ver_dir.join(src_name), &dst) {
            if required {
                return Err(StepError::new(ExitCode::IoError, err));
            }
            log.log(&format!("warn: {err}"));
            if cleanup_warning.is_none() {
                *cleanup_warning = Some(err);
            }
        }
    }

    let previous_id = old_pointer.as_ref().map(|p| p.current.clone());
    let new_pointer = CurrentPointer {
        schema_version: 2,
        current: version_id.clone(),
        previous: previous_id.clone(),
        updated_at: utc_iso8601(),
    };
    write_current_pointer_atomic(&install_dir, &new_pointer)
        .map_err(|e| StepError::new(ExitCode::IoError, format!("写入 current.json 失败: {e}")))?;
    legacy_guard.archive = None;
    log.log(&format!("committed current.json -> {version_id}"));

    if let Err(e) = write_install_registry(&install_dir, &params.state_root, &artifact.app_version)
    {
        log.log(&format!("warn: registry write failed: {e}"));
        if cleanup_warning.is_none() {
            *cleanup_warning = Some(e);
        }
    }
    if let Some(sm) = start_menu_dir() {
        let _ = create_shortcut(
            &sm.join("Mizar.lnk"),
            &install_dir.join("Mizar.exe"),
            &install_dir,
        );
        let _ = create_shortcut(
            &sm.join("卸载 Mizar.lnk"),
            &install_dir.join("Uninstall.exe"),
            &install_dir,
        );
    }
    if params.desktop_shortcut {
        if let Some(desktop) = desktop_dir() {
            let _ = create_shortcut(
                &desktop.join("Mizar.lnk"),
                &install_dir.join("Mizar.exe"),
                &install_dir,
            );
        }
    }

    // Phase 5: Post (release locks, launch & verify, best-effort cleanup)
    guards.release_locks();

    if !params.no_launch {
        ui.set_stage("正在启动新版 Mizar...");
        let target_exe = ver_dir.join("Mizar.exe");
        let launch_failed = match launch_and_wait_ready(&target_exe, Duration::from_secs(60)) {
            Ok(LaunchOutcome::Ready) => {
                log.log("new version confirmed ready");
                None
            }
            Ok(LaunchOutcome::Timeout) => {
                log.log("warn: launch readiness timed out after 60s, keeping new version");
                None
            }
            Ok(LaunchOutcome::ExitedEarly(code)) => {
                Some(format!("新版启动后提前退出 (code={code:?})"))
            }
            Err(e) => Some(format!("新版启动失败: {e}")),
        };
        if let Some(reason) = launch_failed {
            log.log(&reason);
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
                        return Err(StepError::new(
                            ExitCode::RolledBack,
                            "新版启动失败，已自动回退到上一版本",
                        ));
                    }
                }
            }
            return Err(StepError::new(ExitCode::IoError, reason));
        }
    }

    // Best-effort delayed cleanup of older versions & staging
    if let Ok(entries) = fs::read_dir(install_dir.join("versions")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str != version_id && previous_id.as_deref() != Some(name_str.as_ref()) {
                if let Err(e) = remove_dir_safe(&entry.path()) {
                    let w = format!("清理旧版本 {name_str} 失败: {e}");
                    log.log(&format!("warn: {w}"));
                    if cleanup_warning.is_none() {
                        *cleanup_warning = Some(w);
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
                *cleanup_warning = Some(w);
            }
        }
    }

    ui.close();
    Ok(())
}

fn run_uninstall(
    install_dir: PathBuf,
    state_root: PathBuf,
    no_ui: bool,
    log: &Logger,
) -> (ExitCode, ApplierResult) {
    let make_result = |code: ExitCode, msg: Option<String>| ApplierResult {
        status: code.status_str(),
        code: code.code_str(),
        version: None,
        previous_version: None,
        cleanup_warning: None,
        log_path: log.path.to_string_lossy().into_owned(),
        message: msg,
    };

    let _writer = match WriterMutex::try_acquire() {
        Ok(Some(w)) => w,
        Ok(None) => {
            return (
                ExitCode::WriterBusy,
                make_result(
                    ExitCode::WriterBusy,
                    Some("另一个安装或更新事务正在进行中".into()),
                ),
            );
        }
        Err(e) => {
            return (
                ExitCode::IoError,
                make_result(ExitCode::IoError, Some(format!("无法获取写入锁: {e}"))),
            );
        }
    };
    let _active = UpdateActiveEvent::acquire().ok();

    if find_running_mizar_under(&install_dir) {
        let msg = "请先正常退出 Mizar 后再卸载。用户资料将保留。".to_string();
        if !no_ui {
            show_message_box("卸载 Mizar", &msg);
        }
        return (
            ExitCode::AppRunning,
            make_result(ExitCode::AppRunning, Some(msg)),
        );
    }

    let ui = ProgressUi::start(no_ui, "正在卸载 Mizar...");
    ui.enter_commit();

    if let Ok(true) = is_reparse_point(&install_dir) {
        return (
            ExitCode::IoError,
            make_result(
                ExitCode::IoError,
                Some("安装目录是重解析点，拒绝卸载删除".into()),
            ),
        );
    }

    for sub in ["versions", "staging"] {
        let p = install_dir.join(sub);
        if p.exists() {
            if let Err(e) = remove_dir_safe(&p) {
                let msg = format!("清理 {sub} 失败: {e}");
                log.log(&msg);
                return (ExitCode::IoError, make_result(ExitCode::IoError, Some(msg)));
            }
        }
    }
    for file in ["current.json", "Mizar.exe", "installed.flag"] {
        let p = install_dir.join(file);
        if p.exists() {
            if let Err(e) = fs::remove_file(&p) {
                let msg = format!("删除 {file} 失败: {e}");
                log.log(&msg);
                return (ExitCode::IoError, make_result(ExitCode::IoError, Some(msg)));
            }
        }
    }

    remove_shortcuts();
    delete_install_registry();

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

    let _ = state_root;
    ui.close();
    (ExitCode::Ok, make_result(ExitCode::Ok, None))
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
                    desktop_shortcut,
                    no_ui,
                    no_launch,
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
                    desktop_shortcut: false,
                    no_ui,
                    no_launch: false,
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
