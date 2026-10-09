//! The renderer never supplies an executable path or installation command.
use crate::{powershell, startup_log::DesktopLog};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
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
fn request(log: &DesktopLog, action: &str) -> Result<Value, String> {
    let state_path = log.state_root.join("data/runtime.json");
    if fs::metadata(&state_path).map_or(true, |m| m.len() > 64 * 1024) {
        return Err("本地服务身份无法读取。".into());
    }
    let state: Value =
        serde_json::from_slice(&fs::read(state_path).map_err(|_| "本地服务身份无法读取。")?)
            .map_err(|_| "本地服务身份无效。")?;
    let token = state["controlToken"]
        .as_str()
        .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("本地服务身份无效。")?;
    let deadline = Instant::now() + Duration::from_secs(75);
    let address: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "无法连接更新服务。")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "无法提交更新请求。")?;
    let body = json!({"action": action}).to_string();
    stream.write_all(format!("POST /operator/updates/install-plan HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nx-runtime-token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).map_err(|_| "更新请求未完成。")?;
    let mut bytes = Vec::new();
    loop {
        stream
            .set_read_timeout(Some(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or("更新来源重新验证超时。")?,
            ))
            .map_err(|_| "更新响应未完成。")?;
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).map_err(|_| "更新响应未完成。")?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 64 * 1024 {
            return Err("更新响应超出限制。".into());
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "更新响应无效。")?;
    let (headers, body) = text.split_once("\r\n\r\n").ok_or("更新响应无效。")?;
    if headers.to_ascii_lowercase().contains("transfer-encoding:") {
        return Err("更新响应格式不支持。".into());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "更新响应无效。")?;
    if headers.split_whitespace().nth(1) != Some("200") {
        return Err(value["message"]
            .as_str()
            .unwrap_or("更新尚未就绪，请重新检查。")
            .into());
    }
    Ok(value)
}
fn same_path(value: &Value, expected: &Path) -> bool {
    value
        .as_str()
        .and_then(|v| Path::new(v).canonicalize().ok())
        .is_some_and(|p| p == expected)
}
pub fn validate_plan(plan: &Value, root: &Path, state: &Path) -> Result<(), String> {
    if plan["schemaVersion"] != 1
        || !root.join("installed.flag").is_file()
        || !same_path(&plan["bundleRoot"], root)
        || !same_path(&plan["stateRoot"], state)
        || state.starts_with(root)
    {
        return Err("安装目录或用户资料位置不支持自动升级，请从正式发布页下载。".into());
    }
    let path = PathBuf::from(plan["installer"].as_str().ok_or("安装包路径无效。")?);
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|p| p.to_str())
        .ok_or("安装包目录无效。")?;
    if !parent.starts_with("download-")
        || !parent
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.canonicalize().ok())
            != Some(
                state
                    .join("updates")
                    .canonicalize()
                    .map_err(|_| "更新目录不可用。")?,
            )
    {
        return Err("安装包必须来自已验证的更新暂存目录。".into());
    }
    Ok(())
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
            .map_err(|_| "安装目录不可用。")?;
        let plan = match request(&log, "prepare") {
            Ok(plan) => plan,
            Err(error) => {
                let _ = request(&log, "release");
                return Err(error);
            }
        };
        let prepared: Result<(), String> = (|| {
            validate_plan(&plan, &root, &log.state_root)?;
            let path = log
                .state_root
                .join("updates")
                .join(format!("install-plan-{}.json", log.session_id));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| "安装准备记录无法创建。")?;
            let write = file.write_all(plan.to_string().as_bytes());
            drop(file);
            if write.is_err() {
                let _ = fs::remove_file(&path);
                return Err("安装准备记录未能保存。".into());
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
            let _ = fs::remove_file(&path);
            let value: Value = serde_json::from_str(&result?).map_err(|_| "安装工具响应无效。")?;
            let stage = PathBuf::from(value["stageRoot"].as_str().ok_or("安装工具目录缺失。")?)
                .canonicalize()
                .map_err(|_| "安装工具目录不可用。")?;
            let name = stage
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("安装工具目录无效。")?;
            if stage.parent() != Some(log.state_root.join("updates").as_path())
                || !name.starts_with("install-")
                || !name[8..].bytes().all(|c| c.is_ascii_hexdigit())
                || name.len() != 40
            {
                return Err("安装工具目录不在允许范围内。".into());
            }
            *host
                .state::<PendingUpdate>()
                .stage
                .lock()
                .map_err(|_| "更新状态不可用。")? = Some(stage);
            log.event("update_install", "prepared", None);
            Ok(())
        })();
        if prepared.is_err() {
            let _ = request(&log, "release");
        }
        prepared
    })
    .await
    .unwrap_or_else(|_| Err("升级准备未完成，请重试。".into()));
    pending.preparing.store(false, Ordering::Release);
    result?;
    app.exit(0);
    Ok(())
}
pub fn cancel(app: &tauri::AppHandle) {
    let mut cancelled = false;
    if let Ok(mut pending) = app.state::<PendingUpdate>().stage.lock() {
        if let Some(stage) = pending.take() {
            let _ = fs::remove_dir_all(stage);
            cancelled = true;
        }
    }
    if cancelled {
        let _ = request(&app.state::<DesktopLog>(), "release");
    }
}
pub fn launch(stage: &Path, log: &DesktopLog) -> Result<(), String> {
    if crate::health_matches(&crate::bundle_root()?) {
        return Err("制播服务尚未停止，安装未启动。".into());
    }
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
        .env_remove("PSModulePath")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|_| "安装工具未能启动，旧版保持可用。请重新打开 Mizar 后重试。")?;
    log.event("update_install", "helper_started", None);
    Ok(())
}
