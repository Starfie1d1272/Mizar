use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    Ok = 0,
    WriterBusy = 10,
    AppRunning = 11,
    PayloadInvalid = 12,
    IoError = 14,
    Cancelled = 15,
    RolledBack = 16,
    InternalError = 17,
}

impl ExitCode {
    pub fn code_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::WriterBusy => "writer_busy",
            Self::AppRunning => "app_running",
            Self::PayloadInvalid => "payload_invalid",
            Self::IoError => "io_error",
            Self::Cancelled => "cancelled",
            Self::RolledBack => "launch_failed",
            Self::InternalError => "internal_error",
        }
    }
    pub fn status_str(self) -> &'static str {
        match self {
            Self::Ok => "installed",
            Self::RolledBack => "rolled_back",
            Self::Cancelled => "cancelled",
            _ => "failed",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplierResult {
    pub status: &'static str,
    pub code: &'static str,
    pub version: Option<String>,
    pub previous_version: Option<String>,
    pub cleanup_warning: Option<String>,
    pub log_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub enum CommandMode {
    Install {
        payload_dir: PathBuf,
        install_dir: PathBuf,
        state_root: Option<PathBuf>,
        expected_content_digest: Option<String>,
        desktop_shortcut: bool,
        no_ui: bool,
        no_launch: bool,
        result_file: Option<PathBuf>,
    },
    ApplyUpdate {
        payload_dir: PathBuf,
        install_dir: PathBuf,
        state_root: Option<PathBuf>,
        expected_content_digest: String,
        host_pid: u32,
        host_start_time: u64,
        desktop_mutex_handle: Option<usize>,
        no_ui: bool,
        result_file: Option<PathBuf>,
    },
    Uninstall {
        install_dir: PathBuf,
        state_root: Option<PathBuf>,
        no_ui: bool,
        result_file: Option<PathBuf>,
    },
    Preview {
        state: String,
        hold_ms: Option<u64>,
    },
}

fn next_val(args: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
    *i += 1;
    args.get(*i)
        .cloned()
        .ok_or_else(|| format!("缺少参数值：{flag}"))
}

pub fn parse_args() -> Result<CommandMode, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Auto-detect Uninstall.exe invocation from Control Panel / Start Menu
    if args.is_empty() || args.first().is_some_and(|a| a.starts_with('/')) {
        if let Ok(exe) = std::env::current_exe() {
            let stem = exe
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if stem == "uninstall" {
                let install_dir = exe
                    .parent()
                    .ok_or_else(|| "无法定位安装目录".to_string())?
                    .to_path_buf();
                let no_ui = args.iter().any(|a| a.eq_ignore_ascii_case("/S"));
                return Ok(CommandMode::Uninstall {
                    install_dir,
                    state_root: None,
                    no_ui,
                    result_file: None,
                });
            }
        }
    }

    let sub = args
        .first()
        .ok_or_else(|| "缺少子命令：install | apply-update | uninstall".to_string())?
        .as_str();

    let mut payload_dir = None;
    let mut install_dir = None;
    let mut state_root = None;
    let mut expected_content_digest = None;
    let mut host_pid = None;
    let mut host_start_time = None;
    let mut desktop_mutex_handle = None;
    let mut desktop_shortcut = false;
    let mut no_ui = false;
    let mut no_launch = false;
    let mut result_file = None;
    let mut preview_state = None;
    let mut hold_ms = None;

    let mut i = 1;
    while i < args.len() {
        let flag = args[i].as_str();
        match flag {
            "--payload-dir" => payload_dir = Some(PathBuf::from(next_val(&args, &mut i, flag)?)),
            "--install-dir" => install_dir = Some(PathBuf::from(next_val(&args, &mut i, flag)?)),
            "--state-root" => state_root = Some(PathBuf::from(next_val(&args, &mut i, flag)?)),
            "--expected-content-digest" => {
                expected_content_digest = Some(next_val(&args, &mut i, flag)?)
            }

            "--host-pid" => {
                let v = next_val(&args, &mut i, flag)?;
                host_pid = Some(v.parse::<u32>().map_err(|_| format!("无效 PID：{v}"))?);
            }
            "--host-start-time" => {
                let v = next_val(&args, &mut i, flag)?;
                host_start_time = Some(v.parse::<u64>().map_err(|_| format!("无效启动时间：{v}"))?);
            }
            "--desktop-mutex-handle" => {
                let v = next_val(&args, &mut i, flag)?;
                desktop_mutex_handle =
                    Some(v.parse::<usize>().map_err(|_| format!("无效句柄：{v}"))?);
            }
            "--desktop-shortcut" => desktop_shortcut = true,
            "--no-ui" => no_ui = true,
            "--no-launch" => no_launch = true,
            "--result-file" => result_file = Some(PathBuf::from(next_val(&args, &mut i, flag)?)),
            "--state" => preview_state = Some(next_val(&args, &mut i, flag)?),
            "--hold-ms" => {
                let v = next_val(&args, &mut i, flag)?;
                hold_ms = Some(v.parse::<u64>().map_err(|_| format!("无效时长：{v}"))?);
            }
            other => return Err(format!("未知参数：{other}")),
        }
        i += 1;
    }

    match sub {
        "install" => Ok(CommandMode::Install {
            payload_dir: payload_dir.ok_or("缺少 --payload-dir")?,
            install_dir: install_dir.ok_or("缺少 --install-dir")?,
            state_root,
            expected_content_digest,
            desktop_shortcut,
            no_ui,
            no_launch,
            result_file,
        }),
        "apply-update" => Ok(CommandMode::ApplyUpdate {
            payload_dir: payload_dir.ok_or("缺少 --payload-dir")?,
            install_dir: install_dir.ok_or("缺少 --install-dir")?,
            state_root,
            expected_content_digest: expected_content_digest
                .ok_or("apply-update 缺少 --expected-content-digest")?,
            host_pid: host_pid.ok_or("apply-update 缺少 --host-pid")?,
            host_start_time: host_start_time.ok_or("apply-update 缺少 --host-start-time")?,
            desktop_mutex_handle,
            no_ui,
            result_file,
        }),
        "uninstall" => Ok(CommandMode::Uninstall {
            install_dir: install_dir.ok_or("缺少 --install-dir")?,
            state_root,
            no_ui,
            result_file,
        }),
        "preview" => Ok(CommandMode::Preview {
            state: preview_state.unwrap_or_else(|| "verifying".to_string()),
            hold_ms,
        }),
        other => Err(format!("未知子命令：{other}")),
    }
}

pub fn write_result(result: &ApplierResult, result_file: Option<&Path>, state_root: &Path) {
    let Ok(json) = serde_json::to_vec_pretty(result) else {
        return;
    };
    let last_path = state_root.join("logs").join("last-applier-result.json");
    if let Some(parent) = last_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut f) = File::create(&last_path) {
        let _ = f.write_all(&json);
    }
    if let Some(path) = result_file {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut f) = File::create(path) {
            let _ = f.write_all(&json);
        }
    }
}
