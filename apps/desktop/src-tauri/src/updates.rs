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
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct PendingUpdate {
    pub stage: Arc<Mutex<Option<PathBuf>>>,
    preparing: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    gui: Arc<AtomicU64>,
    gui_ticket: Option<u64>,
    publication: Arc<Mutex<()>>,
    attempt: Arc<Mutex<Option<String>>>,
}
impl PendingUpdate {
    pub fn new(stage: Arc<Mutex<Option<PathBuf>>>) -> Self {
        Self {
            stage,
            preparing: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            gui: Arc::new(AtomicU64::new(0)),
            gui_ticket: None,
            publication: Arc::new(Mutex::new(())),
            attempt: Arc::new(Mutex::new(None)),
        }
    }
    pub fn for_gui(&self) -> Self {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        let ticket = self.gui.fetch_add(1, Ordering::AcqRel) + 1;
        self.generation.fetch_add(1, Ordering::AcqRel);
        Self {
            gui_ticket: Some(ticket),
            ..self.clone()
        }
    }
    fn gui_current(&self) -> Result<(), String> {
        if self.gui_ticket != Some(self.gui.load(Ordering::Acquire)) {
            Err("桌面已退出或重建，本次操作已取消，请在当前窗口重试。".into())
        } else {
            Ok(())
        }
    }
    pub fn check(&self) -> Result<(), String> {
        self.gui_current()?;
        // Slow authentication/staging must not prevent starting production.
        if self.stage.lock().map_err(|_| "更新状态不可用。")?.is_some() {
            Err("Mizar 正在准备升级，请完成升级后再打开制作工具。".into())
        } else {
            Ok(())
        }
    }
    pub fn invalidate(&self) {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        if self.gui_ticket.is_some() && self.gui_current().is_err() {
            return;
        }
        self.gui.fetch_add(1, Ordering::AcqRel);
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    fn current(&self, generation: u64) -> Result<(), String> {
        self.gui_current()?;
        if self.generation.load(Ordering::Acquire) != generation {
            Err("桌面已退出或重建，本次更新准备已取消，请重新尝试。".into())
        } else {
            Ok(())
        }
    }
    pub fn recheck(&self, log: &DesktopLog) -> Result<(), String> {
        self.gui_current()?;
        if self.stage.lock().map_err(|_| "更新状态不可用。")?.is_none() {
            return Ok(());
        }
        let attempt = self
            .attempt
            .lock()
            .map_err(|_| "更新状态不可用。")?
            .clone()
            .ok_or("更新准备状态已变化，请重新尝试。")?;
        request(log, "recheck", Some(&attempt))?;
        Ok(())
    }
    pub fn cancel(&self, log: &DesktopLog) {
        let (stage, attempt) = {
            let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
            // A retired GUI cannot cancel the replacement GUI's owner or stage.
            if self.gui_ticket.is_some() && self.gui_current().is_err() {
                return;
            }
            // Process-level recovery also retires a GUI that panicked before
            // Exit. Cancelling within the current GUI keeps that GUI usable.
            if self.gui_ticket.is_none() {
                self.gui.fetch_add(1, Ordering::AcqRel);
            }
            self.generation.fetch_add(1, Ordering::AcqRel);
            let stage = self.stage.lock().ok().and_then(|mut pending| pending.take());
            let attempt = self.attempt.lock().ok().and_then(|owner| owner.clone());
            (stage, attempt)
        };
        if let Some(stage) = stage {
            if let Err(error) = fs::remove_dir_all(stage) {
                io_failure(log, "stage_cleanup", &error, "更新暂存清理失败。");
            }
        }
        if let Some(attempt) = attempt {
            if release_plan(log, &attempt).is_ok() {
                if let Ok(mut owner) = self.attempt.lock() {
                    if owner.as_deref() == Some(attempt.as_str()) {
                        *owner = None;
                    }
                }
            }
        }
    }
}

// The blocking task, not its possibly destroyed renderer future, owns release.
struct Preparation(PendingUpdate);
impl Drop for Preparation {
    fn drop(&mut self) {
        self.0.preparing.store(false, Ordering::Release);
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
fn release_plan(log: &DesktopLog, attempt: &str) -> Result<(), String> {
    if let Err(error) = request(log, "release", Some(attempt)) {
        log.event(
            "update_install",
            "failure",
            Some("phase=release_after_failure; failed; owner retained for recovery"),
        );
        return Err(error);
    }
    Ok(())
}
fn request(log: &DesktopLog, action: &str, attempt: Option<&str>) -> Result<Value, String> {
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
        json!({"action": action, "attemptId": attempt})
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
fn recover_plan(pending: &PendingUpdate, log: &DesktopLog) -> Result<(), String> {
    let recovered = request(log, "recover", None)?;
    let previous = match recovered.get("attemptId") {
        Some(Value::Null) => None,
        Some(Value::String(value))
            if (32..=96).contains(&value.len())
                && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') =>
        {
            Some(value.clone())
        }
        _ => return Err("更新准备状态无法确认，请重启本地服务后重试。".into()),
    };
    *pending.attempt.lock().map_err(|_| "更新状态不可用。")? = previous.clone();
    if let Some(previous) = previous {
        release_plan(log, &previous)?;
        *pending.attempt.lock().map_err(|_| "更新状态不可用。")? = None;
    }
    Ok(())
}

pub fn check_on_startup(app: tauri::AppHandle) {
    let pending = app.state::<PendingUpdate>().inner().clone();
    let log = app.state::<DesktopLog>().inner().clone();
    let generation = pending.generation.load(Ordering::Acquire);
    // Metadata and orphan recovery stay off the UI thread. The process-wide
    // slot also waits for a previous GUI's blocking staging task to really end.
    std::thread::spawn(move || {
        if pending.current(generation).is_err() {
            return;
        }
        let _ = request(&log, "startup", None);
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            if pending.current(generation).is_err() {
                return;
            }
            if pending
                .preparing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                break;
            }
            if Instant::now() >= deadline {
                log.event(
                    "update_install",
                    "failure",
                    Some("phase=startup_recovery; prepare_still_running; owner_retained"),
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _operation = Preparation(pending.clone());
        let result = (|| -> Result<(), String> {
            pending.current(generation)?;
            if pending
                .stage
                .lock()
                .map_err(|_| "更新状态不可用。")?
                .is_some()
            {
                return Ok(());
            }
            recover_plan(&pending, &log)
        })();
        if let Err(error) = result {
            log.event(
                "update_install",
                "failure",
                Some(&format!("phase=startup_recovery; owner_retained; cause={error}")),
            );
        }
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
    let pending = app.state::<PendingUpdate>().inner().clone();
    pending.check()?;
    app.state::<crate::production_exit::ExitGate>().check()?;
    if app.webview_windows().iter().any(|(label, window)| {
        label.starts_with("tool-") && window.is_visible().unwrap_or(true)
    }) {
        return Err("请先保存并关闭编辑和预览窗口。".into());
    }
    if pending.preparing.swap(true, Ordering::AcqRel) {
        return Err("正在准备升级，请稍候。".into());
    }
    let generation = pending.generation.load(Ordering::Acquire);
    let log = app.state::<DesktopLog>().inner().clone();
    let task_log = log.clone();
    let operation = Preparation(pending.clone());
    let attempt = format!(
        "{}-{:016x}",
        log.session_id,
        NEXT_ATTEMPT.fetch_add(1, Ordering::AcqRel)
    );
    let host = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let log = task_log;
        pending.current(generation)?;
        // This process holds the sole desktop mutex and preparation slot. A
        // prior Host may have died after reserving the reused Companion.
        recover_plan(&pending, &log)?;
        pending.current(generation)?;
        *pending.attempt.lock().map_err(|_| "更新状态不可用。")? = Some(attempt.clone());
        let root = crate::host_runtime::bundle_root()?
            .canonicalize()
            .map_err(|error| io_failure(&log, "root_canonicalize", &error, "安装目录无法读取，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。"))?;
        let plan = match request(&log, "prepare", Some(&attempt)) {
            Ok(plan) => plan,
            Err(error) => {
                if release_plan(&log, &attempt).is_ok() {
                    *pending.attempt.lock().map_err(|_| "更新状态不可用。")? = None;
                }
                return Err(error);
            }
        };
        let prepared: Result<(), String> = (|| {
            pending.current(generation)?;
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
            let mut command = crate::powershell::background();
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
            let committed = (|| {
                pending.current(generation)?;
                request(&log, "commit", Some(&attempt))?;
                let _publication = pending
                    .publication
                    .lock()
                    .map_err(|_| "更新状态不可用。")?;
                pending.current(generation)?;
                host.state::<crate::production_exit::ExitGate>().check()?;
                if host.webview_windows().iter().any(|(label, window)| {
                    label.starts_with("tool-") && window.is_visible().unwrap_or(true)
                }) {
                    return Err("请先保存并关闭编辑和预览窗口。".into());
                }
                *pending.stage.lock().map_err(|_| "更新状态不可用。")? = Some(stage.clone());
                log.event("update_install", "prepared", None);
                host.exit(0);
                Ok(())
            })();
            if committed.is_err() {
                if let Err(error) = fs::remove_dir_all(&stage) {
                    io_failure(&log, "stage_cleanup", &error, "更新暂存清理失败。");
                }
            }
            committed
        })();
        if prepared.is_err() && release_plan(&log, &attempt).is_ok() {
            if let Ok(mut owner) = pending.attempt.lock() {
                if owner.as_deref() == Some(attempt.as_str()) {
                    *owner = None;
                }
            }
        }
        prepared
    })
    .await
    .unwrap_or_else(|error| {
        log.event(
            "update_install",
            "failure",
            Some(&format!("phase=prepare_task; cause={error:?}")),
        );
        Err("升级准备意外中断，升级未启动。旧版仍可用，请导出诊断并从正式发布页下载。".into())
    })
}
pub fn recheck(app: &tauri::AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingUpdate>();
    pending.gui_current()?;
    if pending.stage.lock().map_err(|_| "更新状态不可用。")?.is_some()
        && app.webview_windows().iter().any(|(label, window)| {
            label.starts_with("tool-") && window.is_visible().unwrap_or(true)
        })
    {
        return Err("请先保存并关闭编辑和预览窗口。".into());
    }
    pending.recheck(&app.state::<DesktopLog>())
}
pub fn cancel(app: &tauri::AppHandle) {
    app.state::<PendingUpdate>().cancel(&app.state::<DesktopLog>());
}
pub fn launch(stage: &Path, log: &DesktopLog) -> Result<(), String> {
    if crate::host_runtime::health_matches(&crate::host_runtime::bundle_root()?) {
        return Err("制播服务尚未停止，安装未启动。".into());
    }
    let handoff = crate::windows_startup::UpdateHandoff::new()
        .map_err(|error| io_failure(log, "helper_handoff_event", &error, "更新工具接力未建立。"))?;
    let mut command: Command = crate::powershell::background();
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
