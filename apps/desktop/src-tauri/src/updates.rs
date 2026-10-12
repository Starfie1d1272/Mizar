//! The renderer never supplies an executable path or installation command.
use crate::{powershell, startup_log::DesktopLog};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub struct PendingUpdate {
    pub stage: Arc<Mutex<Option<PathBuf>>>,
    preparing: AtomicBool,
}
impl PendingUpdate {
    pub fn new(stage: Arc<Mutex<Option<PathBuf>>>) -> Self {
        Self {
            stage,
            preparing: AtomicBool::new(false),
        }
    }
    pub fn check(&self) -> Result<(), String> {
        if self.preparing.load(Ordering::Acquire)
            || self.stage.lock().map_err(|_| "更新状态不可用。")?.is_some()
        {
            Err("Mizar 正在准备升级，请完成升级后再打开制作工具。".into())
        } else {
            Ok(())
        }
    }
}
fn failure_guidance(summary: &str) -> String {
    if summary.contains('请') {
        summary.into()
    } else {
        format!("{summary} 升级未启动，旧版仍可用。请导出诊断并从正式发布页下载。")
    }
}
fn io_failure(log: &DesktopLog, phase: &str, error: &std::io::Error, summary: &str) -> String {
    log.event(
        "update_install",
        "failure",
        Some(&format!(
            "phase={phase}; os_code={:?}; cause={error:?}",
            error.raw_os_error()
        )),
    );
    failure_guidance(summary)
}
fn json_failure(log: &DesktopLog, phase: &str, error: &serde_json::Error, summary: &str) -> String {
    log.event(
        "update_install",
        "failure",
        Some(&format!(
            "phase={phase}; json_category={:?}; line={}; column={}",
            error.classify(),
            error.line(),
            error.column()
        )),
    );
    failure_guidance(summary)
}
fn release_plan(log: &DesktopLog) {
    if request(log, "release").is_err() {
        log.event(
            "update_install",
            "failure",
            Some("phase=release_after_failure; failed; see preceding request phase and cause"),
        );
    }
}
fn request(log: &DesktopLog, action: &str) -> Result<Value, String> {
    log.event(
        "update_install",
        "begin",
        Some(&format!("phase=install_plan_request; action={action}")),
    );
    let state_path = log.state_root.join("data/runtime.json");
    let metadata = fs::metadata(&state_path).map_err(|error| {
        io_failure(
            log,
            "runtime_metadata",
            &error,
            "无法读取本地服务身份，升级未启动。旧版仍可用，请查看诊断或从正式发布页下载。",
        )
    })?;
    if metadata.len() > 64 * 1024 {
        log.event(
            "update_install",
            "failure",
            Some("phase=runtime_metadata; size_limit_exceeded"),
        );
        return Err(
            "无法读取本地服务身份，升级未启动。旧版仍可用，请查看诊断或从正式发布页下载。".into(),
        );
    }
    let state: Value = serde_json::from_slice(&fs::read(state_path).map_err(|error| {
        io_failure(
            log,
            "runtime_read",
            &error,
            "无法读取本地服务身份，升级未启动。旧版仍可用，请查看诊断或从正式发布页下载。",
        )
    })?)
    .map_err(|error| {
        json_failure(
            log,
            "runtime_json",
            &error,
            "本地服务身份校验失败，升级未启动。请重新打开 Mizar；再次失败时查看诊断。",
        )
    })?;
    let token = state["controlToken"]
        .as_str()
        .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| {
            log.event(
                "update_install",
                "failure",
                Some("phase=runtime_identity; control_token_shape_invalid"),
            );
            "本地服务身份校验失败，升级未启动。请重新打开 Mizar；再次失败时查看诊断。"
        })?;
    let deadline = Instant::now() + Duration::from_secs(75);
    let address: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|error| {
            io_failure(
                log,
                "tcp_connect",
                &error,
                "无法连接本地更新服务，升级未启动。请重新打开 Mizar 后检查更新。",
            )
        })?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| io_failure(log, "tcp_write_timeout", &error, "无法提交更新请求。"))?;
    let body = if action == "startup" {
        json!({"action": action, "sessionId": log.session_id})
    } else {
        json!({"action": action})
    }
    .to_string();
    stream.write_all(format!("POST /operator/updates/install-plan HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nx-runtime-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).map_err(|error| io_failure(log, "tcp_write", &error, "更新请求未完成。"))?;
    let mut bytes = Vec::new();
    loop {
        stream
            .set_read_timeout(Some(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or_else(|| {
                        log.event(
                            "update_install",
                            "failure",
                            Some("phase=response_deadline; timeout"),
                        );
                        failure_guidance("更新来源重新验证超时。")
                    })?,
            ))
            .map_err(|error| io_failure(log, "tcp_read_timeout", &error, "更新响应未完成。"))?;
        let mut chunk = [0; 4096];
        let count = stream
            .read(&mut chunk)
            .map_err(|error| io_failure(log, "tcp_read", &error, "更新响应未完成。"))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 64 * 1024 {
            log.event(
                "update_install",
                "failure",
                Some("phase=response_read; size_limit_exceeded"),
            );
            return Err(failure_guidance("更新响应超出限制。"));
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        log.event(
            "update_install",
            "failure",
            Some(&format!("phase=response_utf8; cause={error}")),
        );
        failure_guidance("更新响应无效。")
    })?;
    let (headers, body) = text.split_once("\r\n\r\n").ok_or_else(|| {
        log.event(
            "update_install",
            "failure",
            Some("phase=response_framing; missing_header_separator"),
        );
        "更新响应格式无效，升级未启动。请查看诊断或从正式发布页下载。"
    })?;
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        log.event(
            "update_install",
            "failure",
            Some("phase=response_framing; unsupported_transfer_encoding"),
        );
        return Err(failure_guidance("更新响应格式不支持。"));
    }
    let value: Value = serde_json::from_str(body)
        .map_err(|error| json_failure(log, "response_json", &error, "更新响应无效。"))?;
    if headers.split_whitespace().nth(1) != Some("200") {
        let status = headers
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u16>().ok());
        log.event(
            "update_install",
            "failure",
            Some(&format!(
                "phase=install_plan_http; action={action}; status={status:?}"
            )),
        );
        return Err(value["message"]
            .as_str()
            .unwrap_or("更新尚未就绪，升级未启动。请导出诊断并核对更新页面的阻断原因。")
            .into());
    }
    log.event(
        "update_install",
        "success",
        Some(&format!("phase=install_plan_request; action={action}")),
    );
    Ok(value)
}
fn same_path(value: &Value, expected: &Path, log: &DesktopLog, phase: &str) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    match Path::new(value).canonicalize() {
        Ok(path) => path == expected,
        Err(error) => {
            io_failure(log, phase, &error, "安装计划位置无法核对。");
            false
        }
    }
}
pub fn check_on_startup(log: DesktopLog) {
    // Best effort background metadata check; failure never blocks or closes the Host.
    std::thread::spawn(move || {
        let _ = request(&log, "startup");
    });
}

fn validate_plan(plan: &Value, root: &Path, log: &DesktopLog) -> Result<(), String> {
    let state = &log.state_root;
    if plan["schemaVersion"] != 1
        || !root.join("installed.flag").is_file()
        || !same_path(&plan["bundleRoot"], root, log, "plan_bundle_canonicalize")
        || !same_path(&plan["stateRoot"], state, log, "plan_state_canonicalize")
        || state.starts_with(root)
    {
        return Err("安装目录或用户资料位置不支持自动升级，请从正式发布页下载。".into());
    }
    let path = PathBuf::from(
        plan["installer"]
            .as_str()
            .ok_or("安装包路径无效，升级未启动。请导出诊断并从正式发布页下载。")?,
    );
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|p| p.to_str())
        .ok_or("安装包目录无效，升级未启动。请导出诊断并从正式发布页下载。")?;
    let expected = state.join("updates").canonicalize().map_err(|error| {
        io_failure(
            log,
            "plan_updates_canonicalize",
            &error,
            "更新目录无法读取，升级未启动。旧版仍可用，请检查用户资料目录权限并导出诊断。",
        )
    })?;
    let actual = path
        .parent()
        .and_then(Path::parent)
        .ok_or("安装包目录无效，升级未启动。请导出诊断并从正式发布页下载。")?
        .canonicalize()
        .map_err(|error| {
            io_failure(
                log,
                "plan_installer_parent_canonicalize",
                &error,
                "安装包目录无法读取，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。",
            )
        })?;
    if !parent.starts_with("download-")
        || !parent
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || actual != expected
    {
        return Err(
            "安装包必须来自已验证的更新暂存目录，升级未启动。请导出诊断并从正式发布页下载。".into(),
        );
    }
    Ok(())
}
fn provider_plan(mut plan: Value, root: &Path, state: &Path) -> Result<Value, String> {
    // The runtime inherits Rust's canonical state path. Normalize the paths
    // inside the JSON too: removing the prefix only from -PlanPath leaves
    // PowerShell 5.1 unable to read the actual installer or state directory.
    let installer = PathBuf::from(plan["installer"].as_str().ok_or("安装包路径无效。")?);
    for (name, path) in [
        ("bundleRoot", root),
        ("stateRoot", state),
        ("installer", &installer),
    ] {
        plan[name] = Value::String(
            powershell::provider_path(path)
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(plan)
}

fn helper_failure(log: &DesktopLog, reason: &str) -> String {
    log.event(
        "update_install",
        "failure",
        Some(&format!("phase=helper_validate; cause={reason}")),
    );
    "安装工具目录未通过安全检查，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。".into()
}

fn plain_helper_directory(path: &Path, log: &DesktopLog) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        io_failure(
            log,
            "helper_directory_metadata",
            &error,
            "安装工具目录无法读取，升级未启动。旧版仍可用，请检查用户资料目录权限并导出诊断。",
        )
    })?;
    // Junctions are reparse points too, even when file_type() is not a symlink.
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err(helper_failure(log, "helper_directory_not_plain"));
    }
    Ok(())
}

fn helper_stage(value: &Value, log: &DesktopLog) -> Result<PathBuf, String> {
    let reported = PathBuf::from(
        value["stageRoot"]
            .as_str()
            .ok_or_else(|| helper_failure(log, "stage_root_missing"))?,
    );
    if !reported.is_absolute() {
        return Err(helper_failure(log, "stage_root_relative"));
    }
    let updates = log.state_root.join("updates");
    plain_helper_directory(&updates, log)?;
    plain_helper_directory(&reported, log)?;
    let canonical = |path: &Path| {
        path.canonicalize().map_err(|error| {
            io_failure(
                log,
                "helper_directory_canonicalize",
                &error,
                "安装工具目录无法确认，升级未启动。旧版仍可用，请导出诊断或从正式发布页下载。",
            )
        })
    };
    let updates = canonical(&updates)?;
    let stage = canonical(&reported)?;
    // Compare filesystem identities on both sides, preserving the direct-child boundary.
    if updates.parent() != Some(log.state_root.as_path())
        || stage.parent() != Some(updates.as_path())
    {
        return Err(helper_failure(log, "helper_parent_mismatch"));
    }
    let name = stage.file_name().and_then(|name| name.to_str());
    if !name.is_some_and(|name| {
        name.starts_with("install-")
            && name.len() == 40
            && name.as_bytes()[8..].iter().all(u8::is_ascii_hexdigit)
    }) {
        return Err(helper_failure(log, "helper_name_invalid"));
    }
    Ok(stage)
}

pub async fn prepare(app: tauri::AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingUpdate>();
    if pending.preparing.swap(true, Ordering::AcqRel) {
        return Err("正在准备升级，请稍候。".into());
    }
    let host = app.clone();
    let result: Result<(), String> = tauri::async_runtime::spawn_blocking(move || {
        host.state::<crate::production_exit::ExitGate>().check()?;
        if host.webview_windows().iter().any(|(label, window)| {
            label.starts_with("tool-") && window.is_visible().unwrap_or(true)
        }) {
            return Err("请先保存并关闭编辑和预览窗口。".into());
        }
        if host
            .state::<PendingUpdate>()
            .stage
            .lock()
            .map_err(|_| "更新状态不可用。")?
            .is_some()
        {
            return Err("更新已经在等待退出。".into());
        }
        let log = host.state::<DesktopLog>();
        let root = crate::bundle_root()?
            .canonicalize()
            .map_err(|error| io_failure(&log, "root_canonicalize", &error, "安装目录无法读取，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。"))?;
        let plan = match request(&log, "prepare") {
            Ok(plan) => plan,
            Err(error) => {
                release_plan(&log);
                return Err(error);
            }
        };
        let prepared: Result<(), String> = (|| {
            validate_plan(&plan, &root, &log).map_err(|error| {
                log.event(
                    "update_install",
                    "failure",
                    Some(&format!("phase=plan_validate; cause={error}")),
                );
                error
            })?;
            let plan = provider_plan(plan, &root, &log.state_root)?;
            let path = log
                .state_root
                .join("updates")
                .join(format!("install-plan-{}.json", log.session_id));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| {
                    io_failure(&log, "plan_create", &error, "安装准备记录无法创建，升级未启动。旧版仍可用，请检查用户资料目录权限与剩余空间并导出诊断。")
                })?;
            let write = file.write_all(plan.to_string().as_bytes());
            drop(file);
            if let Err(error) = write {
                io_failure(&log, "plan_write", &error, "安装准备记录未能保存。");
                if let Err(error) = fs::remove_file(&path) {
                    io_failure(&log, "plan_cleanup", &error, "安装准备记录清理失败。");
                }
                return Err("安装准备记录未能保存，升级未启动。旧版仍可用，请检查用户资料目录权限与剩余空间并导出诊断。".into());
            }
            let mut command = crate::background_powershell();
            command
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(powershell::provider_path(
                    &root.join("resources/scripts/update-install.ps1"),
                ))
                .arg("-Mode")
                .arg("Prepare")
                .arg("-PlanPath")
                .arg(powershell::provider_path(&path));
            let result = powershell::run(command, &log, "更新安装准备", Duration::from_secs(60));
            if let Err(error) = fs::remove_file(&path) {
                io_failure(&log, "plan_cleanup", &error, "安装准备记录清理失败。");
            }
            let value: Value = serde_json::from_str(&result?)
                .map_err(|error| json_failure(&log, "helper_json", &error, "安装工具响应无效，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。"))?;
            let stage = helper_stage(&value, &log)?;
            *host
                .state::<PendingUpdate>()
                .stage
                .lock()
                .map_err(|_| "更新状态不可用。")? = Some(stage);
            log.event("update_install", "prepared", None);
            Ok(())
        })();
        if prepared.is_err() {
            release_plan(&log);
        }
        prepared
    })
    .await
    .unwrap_or_else(|error| {
        app.state::<DesktopLog>().event(
            "update_install",
            "failure",
            Some(&format!("phase=prepare_task; cause={error:?}")),
        );
        Err("升级准备意外中断，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。".into())
    });
    pending.preparing.store(false, Ordering::Release);
    result?;
    app.exit(0);
    Ok(())
}
pub fn cancel(app: &tauri::AppHandle) {
    let mut cancelled = false;
    if let Ok(mut pending) = app.state::<PendingUpdate>().stage.lock() {
        if let Some(stage) = pending.take() {
            if let Err(error) = fs::remove_dir_all(stage) {
                io_failure(
                    &app.state::<DesktopLog>(),
                    "stage_cleanup",
                    &error,
                    "更新暂存清理失败。",
                );
            }
            cancelled = true;
        }
    }
    if cancelled {
        release_plan(&app.state::<DesktopLog>());
    }
}
pub fn launch(stage: &Path, log: &DesktopLog) -> Result<(), String> {
    if crate::health_matches(&crate::bundle_root()?) {
        return Err("制播服务尚未停止，安装未启动。".into());
    }
    let handoff = crate::windows_startup::UpdateHandoff::new()
        .map_err(|error| io_failure(log, "helper_handoff_event", &error, "更新工具接力未建立。"))?;
    let mut command: Command = crate::background_powershell();
    command
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(powershell::provider_path(&stage.join("update-install.ps1")))
        .arg("-Mode")
        .arg("Install")
        .arg("-StageRoot")
        .arg(powershell::provider_path(stage))
        .arg("-HostProcessId")
        .arg(std::process::id().to_string())
        .arg("-ReadyEvent")
        .arg(handoff.name())
        .env_remove("PSModulePath")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| {
        io_failure(
            log,
            "helper_spawn",
            &error,
            "安装工具启动失败，旧版仍可用。请查看诊断中的系统错误，或从正式发布页下载。",
        )
    })?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let ready = loop {
        match handoff.ready() {
            Ok(true) => break Ok(()),
            Ok(false) => (),
            Err(error) => break Err(error),
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break Err(std::io::Error::other(format!("helper exited: {status}")))
            }
            Ok(None) => (),
            Err(error) => break Err(error),
        }
        if Instant::now() >= deadline {
            break Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "helper handoff timeout",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if let Err(error) = ready {
        // This exact helper still waits for this live Host: no destructive phase
        // can begin. Stop only our child before releasing the desktop handle.
        let stopped = match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => child.kill().and_then(|_| child.wait().map(|_| ())),
        };
        if let Err(stop_error) = stopped {
            log.event(
                "update_install",
                "failure",
                Some(&format!(
                    "phase=helper_handoff_cancel; cause={stop_error:?}"
                )),
            );
            return Err(
                "更新工具状态未确认，请暂勿重新启动或安装；保留恢复目录并查看诊断。".into(),
            );
        }
        return Err(io_failure(
            log,
            "helper_handoff",
            &error,
            "更新工具尚未就绪，安装未启动。",
        ));
    }
    log.event("update_install", "helper_started", None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn helper_fixture() -> (PathBuf, DesktopLog) {
        let root = std::env::temp_dir().join(format!(
            "mizar-helper-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = DesktopLog::new(&root, Some(root.join("state"))).unwrap();
        (root, log)
    }

    #[test]
    fn helper_accepts_actual_updates_directory_case_and_provider_paths() {
        let (root, log) = helper_fixture();
        let stage = log
            .state_root
            .join("Updates/install-0123456789abcdef0123456789abcdef");
        fs::create_dir_all(&stage).unwrap();
        for reported in [stage.clone(), powershell::provider_path(&stage)] {
            assert_eq!(
                helper_stage(&json!({ "stageRoot": reported }), &log).unwrap(),
                stage.canonicalize().unwrap()
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn helper_rejects_escape_bad_identity_and_unreadable_directory_with_guidance() {
        let (root, log) = helper_fixture();
        let updates = log.state_root.join("updates");
        fs::create_dir_all(&updates).unwrap();
        let outside = root.join("install-0123456789abcdef0123456789abcdef");
        fs::create_dir(&outside).unwrap();
        let bad_name = updates.join("install-0123456789abcdef0123456789abcdeg");
        fs::create_dir(&bad_name).unwrap();
        let nested = updates.join("nested/install-0123456789abcdef0123456789abcdef");
        fs::create_dir_all(&nested).unwrap();
        for value in [
            json!({ "stageRoot": outside }),
            json!({ "stageRoot": bad_name }),
            json!({ "stageRoot": nested }),
            json!({ "stageRoot": "updates/install-0123456789abcdef0123456789abcdef" }),
            json!({ "stageRoot": 42 }),
            json!({}),
        ] {
            let message = helper_stage(&value, &log).unwrap_err();
            assert!(message.contains("升级未启动"));
            assert!(message.contains("旧版仍可用"));
            assert!(message.contains("导出诊断"));
            assert!(message.contains("正式发布页"));
        }
        let absent = updates.join("install-ffffffffffffffffffffffffffffffff");
        assert!(helper_stage(&json!({ "stageRoot": absent }), &log)
            .unwrap_err()
            .contains("检查用户资料目录权限"));
        let evidence = fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        for cause in [
            "helper_parent_mismatch",
            "helper_name_invalid",
            "stage_root_relative",
            "stage_root_missing",
            "helper_directory_metadata",
            "os_code=Some(",
        ] {
            assert!(evidence.contains(cause), "missing {cause}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn helper_refuses_junctions_without_touching_the_target() {
        let (root, log) = helper_fixture();
        let target = root.join("outside");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "original").unwrap();
        let updates = log.state_root.join("updates");
        let stage = updates.join("install-0123456789abcdef0123456789abcdef");
        for junction in [&updates, &stage] {
            if junction == &stage {
                fs::create_dir(&updates).unwrap();
            }
            let output = crate::background_powershell()
                .arg("-Command")
                .arg("New-Item -ItemType Junction -Path $env:MIZAR_TEST_LINK -Target $env:MIZAR_TEST_TARGET -ErrorAction Stop | Out-Null")
                .env("MIZAR_TEST_LINK", junction)
                .env("MIZAR_TEST_TARGET", &target)
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let reported = if junction == &updates {
                updates.join("install-0123456789abcdef0123456789abcdef")
            } else {
                stage.clone()
            };
            assert!(helper_stage(&json!({ "stageRoot": reported }), &log).is_err());
            fs::remove_dir(junction).unwrap();
            assert_eq!(
                fs::read_to_string(target.join("keep.txt")).unwrap(),
                "original"
            );
        }
        let evidence = fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        assert!(evidence.contains("helper_directory_not_plain"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_plan_directories_keep_the_filesystem_cause() {
        let (root, log) = helper_fixture();
        let bundle = root.join("bundle");
        fs::create_dir(&bundle).unwrap();
        fs::write(bundle.join("installed.flag"), "installed").unwrap();
        let bundle = bundle.canonicalize().unwrap();
        let mut plan = json!({
            "schemaVersion": 1,
            "bundleRoot": powershell::provider_path(&bundle),
            "stateRoot": powershell::provider_path(&log.state_root),
            "installer": log.state_root.join("updates/download-case/Setup.exe")
        });
        assert!(validate_plan(&plan, &bundle, &log)
            .unwrap_err()
            .contains("导出诊断"));
        fs::create_dir(log.state_root.join("updates")).unwrap();
        plan["installer"] = json!(root.join("missing/download-case/Setup.exe"));
        assert!(validate_plan(&plan, &bundle, &log)
            .unwrap_err()
            .contains("正式发布页"));
        plan["bundleRoot"] = json!(root.join("missing-bundle"));
        assert!(validate_plan(&plan, &bundle, &log)
            .unwrap_err()
            .contains("正式发布页"));
        let evidence = fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        assert!(evidence.contains("plan_updates_canonicalize"));
        assert!(evidence.contains("plan_installer_parent_canonicalize"));
        assert!(evidence.contains("plan_bundle_canonicalize"));
        assert!(evidence.contains("os_code=Some("));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn io_and_json_failures_keep_stage_and_codes_without_runtime_input() {
        let root = std::env::temp_dir().join(format!(
            "mizar-update-evidence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = DesktopLog::new(&root, Some(root.join("state"))).unwrap();
        let message = io_failure(
            &log,
            "runtime_read",
            &std::io::Error::from_raw_os_error(5),
            "short UI",
        );
        assert!(message.contains("导出诊断"));
        assert!(message.contains("旧版仍可用"));
        let error =
            serde_json::from_str::<Value>(r#"{"controlToken":"private-control-token","secret":} "#)
                .unwrap_err();
        assert!(json_failure(&log, "runtime_json", &error, "short UI").contains("正式发布页"));
        let evidence = fs::read_to_string(log.directory.join("desktop.ndjson")).unwrap();
        assert!(evidence.contains("runtime_read"));
        assert!(evidence.contains("os_code=Some(5)"));
        assert!(evidence.contains("runtime_json"));
        assert!(evidence.contains("json_category=Syntax"));
        assert!(!evidence.contains("private-control-token"));
        assert!(!evidence.contains("controlToken"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serialized_installation_plan_has_paths_windows_powershell_can_read() {
        let plan = provider_plan(
            json!({
                "schemaVersion": 1,
                "version": "1.1.0",
                "installerSha256": "signed installer identity",
                "installer": r"\\?\C:\Users\User\AppData\Local\Mizar\updates\download-test\Mizar-v1.1.0-Windows-x64-Setup.exe"
            }),
            Path::new(r"\\?\C:\Program Files\Mizar"),
            Path::new(r"\\?\C:\Users\User\AppData\Local\Mizar"),
        )
        .unwrap();
        assert_eq!(plan["bundleRoot"], r"C:\Program Files\Mizar");
        assert_eq!(plan["stateRoot"], r"C:\Users\User\AppData\Local\Mizar");
        assert_eq!(
            plan["installer"],
            r"C:\Users\User\AppData\Local\Mizar\updates\download-test\Mizar-v1.1.0-Windows-x64-Setup.exe"
        );
        assert_eq!(plan["version"], "1.1.0");
        assert_eq!(plan["installerSha256"], "signed installer identity");
    }
}
