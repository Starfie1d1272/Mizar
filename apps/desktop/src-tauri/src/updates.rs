//! The renderer never supplies an executable path or installation command.
use crate::{
    companion_http::{request_with_identity, runtime_token},
    startup_log::DesktopLog,
    windows_startup::{self, DesktopMutex},
};
use serde_json::{json, Value};
use std::{
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Clone)]
pub struct ReadyUpdate {
    pub extract_dir: PathBuf,
    pub install_dir: PathBuf,
    pub content_digest: String,
    pub core_archive_sha256: Option<String>,
    pub installer_sha256: String,
    pub installer_bytes: u64,
}

#[derive(Clone)]
pub struct PendingUpdate {
    pub ready: Arc<Mutex<Option<ReadyUpdate>>>,
    preparing: Arc<AtomicBool>,
    gui: Arc<AtomicU64>,
    gui_ticket: Option<u64>,
    publication: Arc<Mutex<()>>,
}

impl PendingUpdate {
    pub fn new() -> Self {
        Self {
            ready: Arc::new(Mutex::new(None)),
            preparing: Arc::new(AtomicBool::new(false)),
            gui: Arc::new(AtomicU64::new(0)),
            gui_ticket: None,
            publication: Arc::new(Mutex::new(())),
        }
    }

    pub fn for_gui(&self) -> Self {
        let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
        let ticket = self.gui.fetch_add(1, Ordering::AcqRel) + 1;
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
        if self.ready.lock().map_err(|_| "更新状态不可用。")?.is_some() {
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
    }

    pub fn take_ready(&self) -> Option<ReadyUpdate> {
        self.ready.lock().ok().and_then(|mut g| g.take())
    }

    pub fn is_installing(&self) -> bool {
        self.ready.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn cancel(&self, log: &DesktopLog, notify_service: bool) {
        let ready = {
            let _publication = self.publication.lock().unwrap_or_else(|e| e.into_inner());
            if self.gui_ticket.is_some() && self.gui_current().is_err() {
                return;
            }
            if self.gui_ticket.is_none() {
                self.gui.fetch_add(1, Ordering::AcqRel);
            }
            self.ready.lock().ok().and_then(|mut g| g.take())
        };
        if let Some(ready) = ready {
            let _ = fs::remove_dir_all(&ready.extract_dir);
        }
        if notify_service {
            let bg_log = log.clone();
            let _ = std::thread::Builder::new()
                .name("mizar-update-release".into())
                .spawn(move || {
                    let _ = post_install_plan(&bg_log, json!({ "action": "release" }), 3);
                });
        }
    }
}

struct Preparation(PendingUpdate);
impl Drop for Preparation {
    fn drop(&mut self) {
        self.0.preparing.store(false, Ordering::Release);
    }
}

fn post_install_plan(log: &DesktopLog, body: Value, timeout_secs: u64) -> Result<Value, String> {
    let token = runtime_token(log)?;
    let (status, value) = request_with_identity(
        log,
        "POST",
        "/operator/updates/install-plan",
        &body.to_string(),
        Instant::now() + Duration::from_secs(timeout_secs),
        Some(&token),
    )?;
    if status != 200 {
        return Err(value["message"]
            .as_str()
            .unwrap_or("更新尚未就绪，升级未启动。请导出诊断并核对更新页面的阻断原因。")
            .into());
    }
    Ok(value)
}

pub fn check_on_startup(app: tauri::AppHandle) {
    let log = app.state::<DesktopLog>().inner().clone();
    std::thread::spawn(move || {
        let _ = post_install_plan(
            &log,
            json!({ "action": "startup", "sessionId": log.session_id }),
            5,
        );
    });
}

fn resolve_install_dir(bundle_root: &Path) -> PathBuf {
    bundle_root
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "versions"))
        .and_then(Path::parent)
        .unwrap_or(bundle_root)
        .to_path_buf()
}

pub async fn prepare(app: tauri::AppHandle) -> Result<(), String> {
    let pending = app.state::<PendingUpdate>().inner().clone();
    pending.check()?;
    app.state::<crate::production_exit::ExitGate>().check()?;
    if app
        .webview_windows()
        .iter()
        .any(|(label, window)| label.starts_with("tool-") && window.is_visible().unwrap_or(true))
    {
        return Err("请先保存并关闭编辑和预览窗口。".into());
    }
    if pending.preparing.swap(true, Ordering::AcqRel) {
        return Err("正在准备升级，请稍候。".into());
    }
    let log = app.state::<DesktopLog>().inner().clone();
    let task_log = log.clone();
    let operation = Preparation(pending.clone());
    let host = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let log = task_log;
        pending.gui_current()?;
        let root = crate::host_runtime::bundle_root()?;
        if !root.join("installed.flag").is_file() {
            return Err("便携版不支持自动更新，请前往正式发布页下载。".into());
        }
        let install_dir = resolve_install_dir(&root);
        if log.state_root.starts_with(&install_dir) {
            return Err("用户数据目录位于安装目录内，不支持自动升级。".into());
        }

        let plan = post_install_plan(&log, json!({}), 75)?;
        let installer = PathBuf::from(
            plan["installer"]
                .as_str()
                .ok_or("安装包路径无效，升级未启动。")?,
        );
        let content_digest = plan["contentDigest"]
            .as_str()
            .ok_or("安装包摘要无效，升级未启动。")?
            .to_owned();
        let installer_sha256 = plan["installerSha256"]
            .as_str()
            .ok_or("安装包校验和无效，升级未启动。")?
            .to_owned();
        let installer_bytes = plan["installerBytes"]
            .as_u64()
            .ok_or("安装包大小无效，升级未启动。")?;
        let core_archive_sha256 = plan["coreArchiveSha256"].as_str().map(str::to_owned);

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let extract_dir = log
            .state_root
            .join("updates")
            .join(format!("extract-{}-{nonce:x}", std::process::id()));

        let commit_res = (|| -> Result<(), String> {
            fs::create_dir_all(&extract_dir).map_err(|e| format!("无法创建更新解包目录：{e}"))?;

            let extract_status = Command::new(&installer)
                .arg("/S")
                .raw_arg(format!("/MIZAREXTRACT=\"{}\"", extract_dir.display()))
                .creation_flags(0x0800_0000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();

            let extract_ok = matches!(
                extract_status,
                Ok(s) if s.success() && extract_dir.join("mizar-applier.exe").is_file()
            );
            if !extract_ok {
                return Err("新版安装包解包失败，旧版仍可用，请从正式发布页下载。".into());
            }

            let _publication = pending.publication.lock().map_err(|_| "更新状态不可用。")?;
            pending.gui_current()?;
            host.state::<crate::production_exit::ExitGate>().check()?;
            if host.webview_windows().iter().any(|(label, window)| {
                label.starts_with("tool-") && window.is_visible().unwrap_or(true)
            }) {
                return Err("请先保存并关闭编辑和预览窗口。".into());
            }
            *pending.ready.lock().map_err(|_| "更新状态不可用。")? = Some(ReadyUpdate {
                extract_dir: extract_dir.clone(),
                install_dir,
                content_digest,
                core_archive_sha256,
                installer_sha256,
                installer_bytes,
            });
            log.event("update_install", "prepared", None);
            host.exit(0);
            Ok(())
        })();

        if commit_res.is_err() {
            let _ = fs::remove_dir_all(&extract_dir);
            let _ = post_install_plan(&log, json!({ "action": "release" }), 3);
        }
        commit_res
    })
    .await
    .unwrap_or_else(|e| {
        log.event(
            "update_install",
            "failure",
            Some(&format!("phase=prepare_task; cause={e:?}")),
        );
        Err("升级准备意外中断，升级未启动。旧版仍可用。".into())
    })
}

pub fn cancel(app: &tauri::AppHandle) {
    let notify = !app
        .state::<crate::production_exit::VerifiedStop>()
        .complete();
    app.state::<PendingUpdate>()
        .cancel(&app.state::<DesktopLog>(), notify);
}

pub fn launch_applier(
    ready: &ReadyUpdate,
    desktop_mutex: &DesktopMutex,
    log: &DesktopLog,
) -> Result<(), String> {
    if crate::host_runtime::health_matches(&crate::host_runtime::bundle_root()?) {
        return Err("制播服务尚未停止，安装未启动。".into());
    }
    let applier = ready.extract_dir.join("mizar-applier.exe");
    let log_dir = log.state_root.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("applier-launch.log"))
        .map_err(|e| format!("无法创建更新启动日志：{e}"))?;

    let mut args = vec![
        "apply-update".to_string(),
        "--payload-dir".to_string(),
        ready.extract_dir.to_string_lossy().into_owned(),
        "--install-dir".to_string(),
        ready.install_dir.to_string_lossy().into_owned(),
        "--state-root".to_string(),
        log.state_root.to_string_lossy().into_owned(),
        "--expected-content-digest".to_string(),
        ready.content_digest.clone(),
        "--installer-sha256".to_string(),
        ready.installer_sha256.clone(),
        "--installer-bytes".to_string(),
        ready.installer_bytes.to_string(),
        "--host-pid".to_string(),
        std::process::id().to_string(),
        "--host-start-time".to_string(),
        windows_startup::current_process_start_time().to_string(),
        "--desktop-mutex-handle".to_string(),
        (desktop_mutex.raw_handle() as usize).to_string(),
    ];
    if let Some(core_sha) = &ready.core_archive_sha256 {
        args.push("--core-archive-sha256".to_string());
        args.push(core_sha.clone());
    }

    windows_startup::spawn_applier_with_inherited_mutex(&applier, &args, desktop_mutex, &log_file)
        .map_err(|e| format!("无法启动新版本安装执行器：{e}"))?;
    log.event("update_install", "applier_launched", None);
    Ok(())
}
