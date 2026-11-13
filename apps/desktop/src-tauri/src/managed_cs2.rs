use crate::cs2_process::{
    any_cs2_running, close_owned_process, cs2_pids, discover, identity, launch_timestamp, open,
    process_pids, read_identity, same_executable, submit_steam, Process, WorkspaceProcess,
};
use crate::cs2_session::SessionStore;
use crate::cs2_session_record::SessionRecord;
use crate::desktop_types::{
    BackupSelection, Cs2ConfigPhase, Cs2ConfigStatus, FrameRateLimit, Ready,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

fn owned_process(
    record: &SessionRecord,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<WorkspaceProcess>, String> {
    crate::cs2_process::verified_process(record.process_identity().as_ref(), log)
}
fn launched_process(
    value: &SessionRecord,
    log: &crate::startup_log::DesktopLog,
) -> Result<(Option<(u32, u64)>, Value), String> {
    let launch_time = value.launch_time().ok_or("CS2 启动时间记录缺失。")?;
    let executable = value.executable.as_str();
    let mut candidates = Vec::new();
    let mut observations = Vec::new();
    for pid in cs2_pids(log)? {
        if let Some(process) = open(pid, log)? {
            if !process.running(log, "无法确认 CS2 是否运行，备份仍保留。")? {
                continue;
            }
            let (created, actual) = identity(&process, log)?;
            let matches = same_executable(&actual, executable);
            observations.push(json!({"pid":pid,"created":created,"afterLaunch":created >= launch_time,"pathMatches":matches,"actualExecutable":actual}));
            if created >= launch_time && matches {
                candidates.push((pid, created));
            }
        }
    }
    match candidates.as_slice() {
        [] => Ok((None, json!(observations))),
        [found] => Ok((Some(*found), json!(observations))),
        _ => Err("CS2 启动身份不唯一，请退出游戏并取消 Steam 启动请求后恢复备份。".into()),
    }
}

/// Read-only recovery facts usable before the local service or WebView exists.
#[derive(Clone, Copy, Debug, Default)]
pub struct StartupRecoveryStatus {
    pub pending: bool,
    pub running: bool,
    pub uncertain: bool,
    pub requires_service: bool,
}
impl StartupRecoveryStatus {
    pub fn permits_restore(self, confirm_steam_cancelled: bool) -> Result<(), String> {
        if self.running {
            return Err("CS2 正在运行，未恢复配置。请先正常退出游戏，再重新检查。".into());
        }
        if self.uncertain && !confirm_steam_cancelled {
            return Err(
                "Steam 启动仍待确认。请先取消启动请求并确认 CS2 已关闭，再明确确认恢复。".into(),
            );
        }
        Ok(())
    }
}

pub struct ManagedCs2 {
    store: SessionStore,
    log: crate::startup_log::DesktopLog,
    message: Option<String>,
    launch_observation: Option<Value>,
    selected_backup: Option<Value>,
    camera: Arc<Mutex<Option<CameraLease>>>,
    mulnx_launcher: Option<Arc<crate::mulnx_launch::HiddenLauncher>>,
    source_resume: Mutex<Option<(String, std::time::Instant, bool)>>,
}

pub(crate) struct CameraLease {
    process: WorkspaceProcess,
    lease: String,
    invalidated: bool,
}
/// Serialize renewal with revocation. This lock never acquires ManagedCs2.
pub(crate) fn pulse_camera(
    state: &Mutex<Option<CameraLease>>,
    log: &crate::startup_log::DesktopLog,
) {
    let mut state = match state.lock() {
        Ok(state) => state,
        Err(error) => {
            if let Some(camera) = error.into_inner().as_mut() {
                camera.invalidated = true;
            }
            return;
        }
    };
    let Some(camera) = state.as_mut() else {
        return;
    };
    if camera.invalidated {
        return;
    }
    let valid = camera.process.is_running()
        && cs2_pids(log).is_ok_and(|pids| pids == vec![camera.process.pid]);
    let result = if valid {
        crate::production_exit::camera_session(log, "pulse", Some(&camera.lease), None)
    } else {
        Err("受管游戏身份已变化。".into())
    };
    if let Err(error) = result {
        camera.invalidated = true;
        let retired =
            crate::production_exit::camera_session(log, "invalidate", Some(&camera.lease), None)
                .is_ok();
        if retired {
            *state = None;
        }
        log.event("managed_camera_isolation", "failure", Some(&error));
    }
}
struct ReplacementTarget {
    process: Process,
    pid: u32,
    created: u64,
    managed: bool,
}

fn valid_preparation_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn replacement_decision(
    current: Option<(u32, u64, bool)>,
    expected_pid: Option<u32>,
    expected_created: Option<u64>,
    same_preparation: bool,
) -> Result<bool, String> {
    if expected_pid.is_some() != expected_created.is_some() {
        return Err("游戏身份无效，请重试。".into());
    }
    if let Some((pid, created, managed)) = current {
        if Some(pid) != expected_pid || Some(created) != expected_created {
            return Err("游戏实例已变化，未关闭游戏；请重新检查后重试。".into());
        }
        return Ok(managed && same_preparation);
    }
    // The selected process may have already exited; no process is closed here.
    Ok(false)
}
impl ManagedCs2 {
    pub fn new(log: crate::startup_log::DesktopLog) -> Self {
        Self {
            store: SessionStore::new(log.state_root.clone()),
            log,
            message: None,
            launch_observation: None,
            selected_backup: None,
            camera: Arc::new(Mutex::new(None)),
            mulnx_launcher: None,
            source_resume: Mutex::new(None),
        }
    }
    pub(crate) fn remember_mulnx_launcher(
        &mut self,
        launcher: Arc<crate::mulnx_launch::HiddenLauncher>,
    ) {
        self.mulnx_launcher = Some(launcher);
    }
    pub(crate) fn owns_mulnx_launcher(&self, pid: u32) -> Result<bool, String> {
        match &self.mulnx_launcher {
            Some(launcher) if launcher.pid() == pid => {
                launcher.running().map_err(|e| e.to_string())
            }
            _ => Ok(false),
        }
    }
    fn recovery_identity(&self) -> Result<(PathBuf, PathBuf, u32), String> {
        let (executable, video, steam) = discover(&self.log)?;
        steam.validate(&self.log)?;
        Ok((executable, video, steam.account))
    }
    pub(crate) fn mark_observer_mulnx_options_clean(&self) -> Result<(), String> {
        self.store.mark_mulnx_options_clean()
    }
    pub(crate) fn mulnx_observer_receipt_matches(
        &self,
        pid: u32,
        created: u64,
        executable: &Path,
    ) -> Result<bool, String> {
        if self.store.full_spectator_pending() || self.store.load()?.is_some() {
            return Ok(false);
        }
        Ok(self
            .store
            .mulnx_observer_matches(pid, created, executable)?
            .is_some())
    }
    /// Never poll/recover here: merely showing a startup error must not write files.
    pub fn startup_recovery_status(&self) -> Result<StartupRecoveryStatus, String> {
        let journal = self.store.load()?;
        let requires_service = crate::demo_test::requires_recovery(&self.log, journal.as_ref());
        Ok(StartupRecoveryStatus {
            pending: journal.is_some()
                || self.store.spectator_pending()
                || self.store.full_spectator_pending()
                || self.store.playback_cleanup_pending()
                || requires_service,
            running: any_cs2_running(&self.log)?,
            uncertain: journal
                .as_ref()
                .is_some_and(SessionRecord::unconfirmed_launch)
                || self.store.mulnx_observer_unconfirmed()?
                || (journal.is_some()
                    && self
                        .log
                        .state_root
                        .join("data/mulnx-launch/pending.json")
                        .exists()),
            requires_service,
        })
    }
    /// Configuration recovery only. Never closes a game or certifies production exit.
    pub fn restore_at_startup(
        &mut self,
        confirm_steam_cancelled: bool,
    ) -> Result<Option<String>, String> {
        self.startup_recovery_status()?
            .permits_restore(confirm_steam_cancelled)?;
        // The existing owner rechecks process identity and writeback before writes.
        self.message = None;
        self.restore_backup(confirm_steam_cancelled)?;
        // Core restoration can succeed while cleanup retains a warning and journal.
        // Return the owner's actual result, without inventing another recovery state.
        Ok(self.message.clone())
    }

    // Discovery and process identity are repeated at the mutation boundary. The
    // webview never chooses an executable or gains authority from a bare PID.
    fn replacement_target(&self) -> Result<Option<ReplacementTarget>, String> {
        let (executable, _, steam) = discover(&self.log)?;
        steam.validate(&self.log)?;
        let journal = self.store.load()?;
        if journal
            .as_ref()
            .is_some_and(SessionRecord::unconfirmed_launch)
        {
            return Err("上次游戏启动仍待确认，请等待游戏身份确认后重试。".into());
        }
        let pids = cs2_pids(&self.log)?;
        let pid = match pids.as_slice() {
            [] => return Ok(None),
            [pid] => *pid,
            _ => return Err("检测到多个 CS2 实例，无法安全确定要关闭的游戏。".into()),
        };
        let process = open(pid, &self.log)?.ok_or("游戏实例已变化，请重试。")?;
        let (created, actual) = identity(&process, &self.log)?;
        if !process.is_running()
            || !same_executable(&actual, &executable.to_string_lossy())
            || cs2_pids(&self.log)? != vec![pid]
        {
            return Err("游戏身份或所选安装位置已变化，未关闭游戏。".into());
        }
        let managed = journal.as_ref().is_some_and(|v| {
            v.pid() == Some(pid)
                && v.created() == Some(created)
                && same_executable(&actual, &v.executable)
        });
        Ok(Some(ReplacementTarget {
            process,
            pid,
            created,
            managed,
        }))
    }

    pub fn preflight_replacement(&self) -> Result<Value, String> {
        let target = self.replacement_target()?;
        let journal = self.store.load()?;
        Ok(json!({
            "target": target.map(|p| json!({"pid":p.pid,"created":p.created.to_string(),"managed":p.managed})),
            "preparationId": journal.as_ref().and_then(|v| v.preparation_id.as_deref()),
        }))
    }

    pub fn replace_for_preparation(
        &mut self,
        expected_pid: Option<u32>,
        expected_created: Option<u64>,
        preparation_id: &str,
        guard: &crate::preparation_gate::PreparationGuard<'_>,
    ) -> Result<bool, String> {
        if !valid_preparation_id(preparation_id) {
            return Err("启动事务或游戏身份无效，请重试。".into());
        }
        let target = self.replacement_target()?;
        let same_preparation = self
            .store
            .load()?
            .as_ref()
            .is_some_and(|v| v.preparation_id.as_deref() == Some(preparation_id));
        if replacement_decision(
            target.as_ref().map(|p| (p.pid, p.created, p.managed)),
            expected_pid,
            expected_created,
            same_preparation,
        )? {
            return Ok(true);
        }
        let journal = self.store.load()?;
        if journal.is_some() && target.as_ref().is_some_and(|target| !target.managed) {
            return Err("已有游戏配置恢复尚未完成，未关闭外部游戏。".into());
        }
        if target.as_ref().is_some_and(|target| target.managed) {
            crate::production_exit::finish_managed_game(&self.log.clone(), |requires_proof| {
                guard.check()?;
                self.finish_with_guard(false, guard)?;
                if requires_proof {
                    self.confirm_game_stopped()?;
                }
                Ok(())
            })?;
        } else {
            if let Some(target) = target {
                let (created, actual) = identity(&target.process, &self.log)?;
                if cs2_pids(&self.log)? != vec![target.pid]
                    || created != target.created
                    || !actual
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("cs2.exe"))
                    || !target.process.is_running()
                {
                    return Err("游戏实例已变化，未关闭游戏；请重试。".into());
                }
                self.log.event(
                    "external_game_replace",
                    "begin",
                    Some(
                        &json!({"pid":target.pid,"created":target.created.to_string()}).to_string(),
                    ),
                );
                guard.commit(|| {
                    close_owned_process(&target.process, target.pid, target.created, &self.log)
                })?;
                self.log.event(
                    "external_game_replace",
                    "success",
                    Some(
                        &json!({"pid":target.pid,"created":target.created.to_string()}).to_string(),
                    ),
                );
            }
            self.confirm_game_stopped()?;
            self.restore_backup_for_start()?;
        }
        // Old per-session Demo files are not referenced by a new launch. Keep
        // their cleanup visible without treating it as unresolved game state.
        self.check_preserved_start()?;
        if crate::demo_test::requires_recovery(&self.log, None) {
            return Err("原游戏配置仍待恢复，请重试。".into());
        }
        Ok(false)
    }
    pub fn workspace_process(&self) -> Result<Option<WorkspaceProcess>, String> {
        let Some(value) = self.store.load()? else {
            return Ok(None);
        };
        owned_process(&value, &self.log)
    }
    /// Read-only diagnostics for the verified managed game.
    pub fn console_source(&self) -> Result<Option<(SessionRecord, WorkspaceProcess)>, String> {
        let Some(process) = self.workspace_process()? else {
            return Ok(None);
        };
        let Some(context) = self.store.load()? else {
            return Ok(None);
        };
        Ok(Some((context, process)))
    }
    /// Inspection only: do not adopt a process, write a session, restore config or close a game.
    pub(crate) fn mulnx_launcher_running(&self) -> Result<bool, String> {
        Ok(!process_pids("CS2Injector.exe", &self.log)?.is_empty())
    }
    pub fn mulnx_handoff_status(&self) -> Result<Value, String> {
        self.observe_mulnx_handoff()?
            .ok_or_else(|| "CS2 程序路径暂时无法读取，请稍后重试准备；本次启动记录仍保留。".into())
    }
    /// None retains the whole unknown snapshot, including possible extra instances.
    pub(crate) fn observe_mulnx_handoff(&self) -> Result<Option<Value>, String> {
        let owned = self.workspace_process()?;
        let mut processes = Vec::new();
        for pid in cs2_pids(&self.log)? {
            let Some(process) = open(pid, &self.log)? else {
                continue;
            };
            if process.has_exited() {
                continue;
            }
            let Some((created, executable)) = read_identity(&process, &self.log)? else {
                return Ok(None);
            };
            if !process.is_running()
                || !executable
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("cs2.exe"))
            {
                continue;
            }
            let managed = owned
                .as_ref()
                .is_some_and(|p| p.pid == pid && p.created == created && p.is_running());
            processes.push(json!({"pid": pid, "created": created.to_string(), "executable": executable, "managed": managed}));
        }
        // Snapshot of kernel identity only; neither launcher provenance nor MulNX readiness.
        Ok(Some(
            json!({"processes": processes, "url": "http://127.0.0.1:3000/"}),
        ))
    }
    /// Request capability only; every launch repeats discovery, these guards and backup.
    /// Never run PowerShell or create recovery work while polling status.
    fn check_preserved_start(&self) -> Result<(), String> {
        self.store.check_start_recovery()?;
        if !fs::symlink_metadata(self.log.state_root.join("data/mulnx-launch/pending.json"))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            || self.mulnx_launcher_running()?
        {
            return Err("请先确认并结束原启动请求，再使用当前设置启动。".into());
        }
        if any_cs2_running(&self.log)? {
            return Err("请先正常退出 CS2，再使用当前设置启动。".into());
        }
        Ok(())
    }

    pub fn status(&self) -> Result<Cs2ConfigStatus, String> {
        let pending = self.store.load()?;
        let owned_running = pending
            .as_ref()
            .map(|value| owned_process(value, &self.log))
            .transpose()?
            .flatten()
            .is_some();
        let running = owned_running;
        let preferences = self.store.preferences()?;
        let mulnx_uncertain = self.store.mulnx_observer_unconfirmed()?
            || (pending.is_some()
                && self
                    .log
                    .state_root
                    .join("data/mulnx-launch/pending.json")
                    .exists());
        let mulnx_launch_resumable = if pending
            .as_ref()
            .is_some_and(|v| v.mulnx_launch && v.was_submitted())
        {
            std::fs::read(self.log.state_root.join("data/mulnx-launch/pending.json"))
                .ok()
                .filter(|bytes| bytes.len() <= 16 * 1024)
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(|record| {
                    record["request"] == "submitted"
                        && record["executable"].as_str().is_some_and(|path| {
                            pending
                                .as_ref()
                                .map(|v| v.executable.as_str())
                                .is_some_and(|expected| path.eq_ignore_ascii_case(expected))
                        })
                })
                .and_then(|record| {
                    record["launcherPid"]
                        .as_u64()
                        .filter(|pid| *pid > 0)
                        .and_then(|pid| u32::try_from(pid).ok())
                })
                .is_some_and(|pid| self.owns_mulnx_launcher(pid).unwrap_or(false))
        } else {
            false
        };
        Ok(Cs2ConfigStatus {
            busy: Ready,
            phase: if mulnx_uncertain
                || pending
                    .as_ref()
                    .is_some_and(SessionRecord::unconfirmed_launch)
            {
                Cs2ConfigPhase::Uncertain
            } else if running {
                Cs2ConfigPhase::Running
            } else if pending.is_some() {
                Cs2ConfigPhase::Pending
            } else {
                Cs2ConfigPhase::Idle
            },
            quality_preset: preferences.quality,
            frame_rate_limit: FrameRateLimit::try_from(preferences.frame_rate_limit)
                .map_err(|_| "CS2 帧率设置无法读取。")?,
            prefer_mulnx: preferences.prefer_mulnx,
            preparation_id: pending
                .as_ref()
                .and_then(|v| v.preparation_id.as_deref())
                .map(str::to_owned),
            spectator_recovery_pending: (self.store.spectator_pending()
                || self.store.full_spectator_pending())
                && pending.is_none(),
            native_hud_toggle: running
                && pending
                    .as_ref()
                    .is_some_and(|v| v.native_hud_toggle && v.spectator_cfg),
            demo_cleanup_pending: self.store.playback_cleanup_pending() && pending.is_none(),
            demo_camera_request_id: pending
                .as_ref()
                .filter(|v| v.mulnx_launch)
                .and_then(|v| v.demo_test_request_id.as_deref())
                .map(str::to_owned),
            observer_hud_pending: crate::observer_hud::pending(&self.log),
            spectator_warning: self.store.spectator_warning().or_else(|| {
                pending
                    .as_ref()
                    .and_then(|value| value.spectator_warning.as_deref())
                    .map(str::to_owned)
            }),
            can_preserve: pending.is_none() && self.check_preserved_start().is_ok(),
            preserve_settings: pending.as_ref().is_some_and(|v| v.preserve_settings),
            pending: pending.is_some(),
            mulnx_launch_resumable,
            camera_lease_ready: self.camera.lock().is_ok_and(|state| {
                state.as_ref().is_some_and(|camera| {
                    !camera.invalidated
                        && camera.process.is_running()
                        && cs2_pids(&self.log).is_ok_and(|pids| pids == vec![camera.process.pid])
                })
            }),
            running,
            message: self.message.clone(),
        })
    }
    /// Preparation may reuse only this owner's live process and installed source proof.
    pub(crate) fn preparation_status(&self, id: &str) -> Result<Value, String> {
        let status = self.status()?;
        let journal = self.store.load()?;
        if status.running && status.preparation_id.as_deref() == Some(id) {
            let journal = journal.as_ref().ok_or("受管游戏记录不可用。")?;
            self.store.verify_gsi_source(journal)?;
        }
        // Pending/unknown launches and external games are not proof of an ended attempt.
        let mut value = serde_json::to_value(status).map_err(|error| error.to_string())?;
        value["restartAllowed"] = json!(journal.is_none() && !any_cs2_running(&self.log)?);
        Ok(value)
    }

    pub fn preferences(
        &mut self,
        preferences: crate::cs2_preferences::Preferences,
    ) -> Result<(), String> {
        self.store.set_preferences(preferences)
    }

    fn commit_managed_source(&self, journal: &mut SessionRecord) -> Result<(), String> {
        if journal.gsi_source.is_none() {
            return Ok(());
        }
        self.store.verify_gsi_source(journal)?;
        let pid = journal.pid().ok_or("游戏身份未确认。")?;
        let created = journal.created().ok_or("游戏身份未确认。")?;
        let executable = journal.executable.as_str().to_owned();
        let source = journal.gsi_source.as_ref().ok_or("受管来源资格缺失。")?;
        let ticket = source.ticket.clone();
        let source_id = source.source_id.clone();
        if cs2_pids(&self.log)? != vec![pid] {
            return Err("游戏身份不唯一。".into());
        }
        let process = open(pid, &self.log)?.ok_or("游戏已退出。")?;
        let (actual_created, actual_executable) = identity(&process, &self.log)?;
        if actual_created != created || !same_executable(&actual_executable, &executable) {
            return Err("游戏身份已变化。".into());
        }
        let committed = source.committed;
        let resume_key = if committed {
            let runtime: Value = serde_json::from_slice(
                &fs::read(self.log.state_root.join("data/runtime.json"))
                    .map_err(|_| "本地服务身份不可用。")?,
            )
            .map_err(|_| "本地服务身份不可用。")?;
            let instance = runtime["instanceId"]
                .as_str()
                .ok_or("本地服务身份不可用。")?;
            let key = format!("{instance}:{source_id}:{pid}:{created}");
            if let Ok(state) = self.source_resume.lock() {
                if let Some((last, at, succeeded)) = state.as_ref() {
                    if last == &key && (*succeeded || at.elapsed() < Duration::from_secs(10)) {
                        return Ok(());
                    }
                }
            }
            Some(key)
        } else {
            None
        };
        let mut request = json!({
            "action":if committed { "resume" } else { "commit" }, "ticket":ticket,
            "managedSessionIdentity":{"pid":pid,"created":created.to_string(),"executable":executable}
        });
        if committed {
            request["sourceId"] = json!(source_id);
        }
        let result = crate::production_exit::managed_source_request(&self.log, request);
        if let Some(key) = resume_key {
            if let Ok(mut state) = self.source_resume.lock() {
                *state = Some((
                    key,
                    std::time::Instant::now(),
                    result.as_ref().is_ok_and(|response| response["ok"] == true),
                ));
            }
        }
        let response = result?;
        if response["ok"] != true {
            return Err("受管游戏来源未能确认。".into());
        }
        if !committed {
            journal
                .gsi_source
                .as_mut()
                .ok_or("受管来源资格缺失。")?
                .committed = true;
            self.store.save(journal)?;
        }
        Ok(())
    }

    fn retry_source_cancel(&self) -> Result<(), String> {
        let Some(request) = self.store.pending_source_cancel()? else {
            return Ok(());
        };
        let response = crate::production_exit::managed_source_request(&self.log, request)?;
        if response["ok"] != true {
            return Err("受管来源清理未确认。".into());
        }
        self.store.clear_source_cancel()
    }

    fn retry_source_retire(&self) -> Result<(), String> {
        let Some(mut record) = self.store.pending_source_retire()? else {
            return Ok(());
        };
        self.confirm_game_stopped()?;
        let source_id = record["sourceId"]
            .as_str()
            .ok_or("受管来源退出记录无效。")?
            .to_owned();
        let runtime: Value = serde_json::from_slice(
            &fs::read(self.log.state_root.join("data/runtime.json"))
                .map_err(|_| "本地服务身份不可用。")?,
        )
        .map_err(|_| "本地服务身份不可用。")?;
        let instance = runtime["instanceId"]
            .as_str()
            .ok_or("本地服务身份不可用。")?;
        let ticket = if record["runtimeInstanceId"].as_str() == Some(instance)
            && record["ticket"].is_string()
        {
            record["ticket"]
                .as_str()
                .ok_or("受管来源退出记录无效。")?
                .to_owned()
        } else {
            let response = crate::production_exit::managed_source_request(
                &self.log,
                json!({"action":"retire","phase":"prepare","expectedSourceId":source_id}),
            )?;
            let ticket = response["ticket"]
                .as_str()
                .ok_or("受管来源退出资格无效。")?
                .to_owned();
            record["ticket"] = json!(ticket.clone());
            record["runtimeInstanceId"] = json!(instance);
            self.store.remember_source_retire(&record)?;
            ticket
        };
        for phase in ["settle", "confirm"] {
            let response = crate::production_exit::managed_source_request(
                &self.log,
                json!({"action":"retire","phase":phase,"ticket":ticket}),
            )?;
            if response["ok"] != true {
                return Err("受管来源退出未确认。".into());
            }
        }
        self.store.clear_source_retire()
    }

    pub fn recover(&mut self, confirm_steam_cancelled: bool) -> Result<(), String> {
        crate::cs2_frame_rate_live::retire_ended(&self.log)?;
        let Some(mut value) = self.store.load()? else {
            return Ok(());
        };
        // MulNX requires its gateway check before a process can be adopted.
        // A submitted or interrupted launch remains pending until that check or
        // explicit cancellation after the launcher and game have stopped.
        if self
            .log
            .state_root
            .join("data/mulnx-launch/pending.json")
            .exists()
        {
            if !confirm_steam_cancelled {
                return Ok(());
            }
            if any_cs2_running(&self.log)? || self.mulnx_launcher_running()? {
                return Err("请先关闭 CS2 和 MulNX 启动器，再恢复配置。".into());
            }
            let executable = value.executable.as_str();
            // An unsubmitted launch can be recovered while its workspace is
            // already live. Only its own still-active preparation grants access.
            let preparation = value
                .preparation_id
                .as_deref()
                .and_then(|id| crate::preparation_task::mulnx_context(id).ok());
            crate::production_exit::cleanup_mulnx(&self.log, Path::new(executable), preparation)?;
            std::fs::remove_file(self.log.state_root.join("data/mulnx-launch/pending.json"))
                .map_err(|_| "MulNX 启动记录无法清理，原备份仍保留。")?;
        }
        // A delayed Steam launch remains a transaction until its identity is
        // known, or the operator explicitly cancels Steam's pending request.
        if SessionRecord::unconfirmed_launch(&value) {
            let (found, observation) = launched_process(&value, &self.log)?;
            if self.launch_observation.as_ref() != Some(&observation) {
                self.log.event("cs2_launch", "success", Some(&json!({"stage":"observe", "launchTime":value.launch_time(), "expectedExecutable":value.executable, "processes":observation}).to_string()));
                self.launch_observation = Some(observation);
            }
            if let Some((pid, created)) = found {
                value.bind(pid, created)?;
                self.store.save(&value)?;
                // Running and preserveSettings already describe a successful launch.
                // Retire the pending-launch message; do not turn success into recovery feedback.
                self.message = None;
            } else if !confirm_steam_cancelled {
                self.message = Some("正在等待 Steam 启动 CS2；配置较低或网络较慢时可能需要更久。Mizar 会继续跟踪；如需取消，请先取消 Steam 启动请求，再恢复备份。".into());
                return Ok(());
            }
        }
        if owned_process(&value, &self.log)?.is_some() {
            if confirm_steam_cancelled {
                return Err("CS2 正在运行，请先退出游戏再恢复备份。".into());
            }
            self.commit_managed_source(&mut value)?;
            return Ok(());
        }
        // A remote/OBS failure cannot prevent restoring verified local files after game exit.
        // Keep the Demo marker; only complete its formal-data restoration after confirmation.
        let trial = crate::demo_test::quarantine_if_needed(&self.log, Some(&value));
        if any_cs2_running(&self.log)? {
            return Err("等待 CS2 退出后恢复原配置。".into());
        }
        // Allow the game to finish saving after its process exits.
        thread::sleep(Duration::from_millis(1500));
        if any_cs2_running(&self.log)? {
            return Err("等待 CS2 退出后恢复原配置。".into());
        }
        if confirm_steam_cancelled && SessionRecord::unconfirmed_launch(&value) {
            value.cancel()?;
            self.store.save(&value)?;
        }
        if let Some(source) = value.gsi_source.as_ref() {
            let source_id = source.source_id.clone();
            self.confirm_game_stopped()?;
            self.store
                .remember_source_retire(&json!({"sourceId":source_id}))?;
            if !source.committed {
                let ticket = source.ticket.clone();
                value.source_cancel_ticket = Some(ticket);
            } else {
                value.managed_source_request_id = None;
            }
            self.store.save(&value)?;
            self.store.restore_gsi_source(&mut value)?;
        }
        if self.retry_source_retire().is_err() {
            self.log
                .event("managed_source", "pending", Some("stage=retire"));
        }
        if let Some(request_id) = value.managed_source_request_id.as_deref() {
            let request = if let Some(ticket) = value.source_cancel_ticket.as_deref() {
                json!({"action":"cancel","ticket":ticket})
            } else {
                json!({"action":"cancel","requestId":request_id})
            };
            self.store.remember_source_cancel(&request)?;
            if self.retry_source_cancel().is_err() {
                self.log
                    .event("managed_source", "pending", Some("stage=cancel"));
            }
            value.managed_source_request_id = None;
            value.source_cancel_ticket = None;
            self.store.save(&value)?;
        }
        if value.version() == 4 {
            let (_, video, steam) = discover(&self.log)?;
            if Path::new(&value.video)
                != std::fs::canonicalize(&video)
                    .map_err(|e| crate::cs2_session::io_error("恢复目标无法确认。", &e))?
            {
                return Err("请登录原目标 Steam 账号后重试恢复。".into());
            }
            steam.validate(&self.log)?;
        }
        // Preserve Demo quarantine until all core cleanup has completed.
        let had_spectator = self.store.spectator_pending() || self.store.full_spectator_pending();
        let spectator_error = if value.full_snapshot {
            let (executable, video, account) = self.recovery_identity()?;
            if any_cs2_running(&self.log)? {
                return Err("等待 CS2 退出后恢复原配置。".into());
            }
            self.store
                .restore_coordinated(&video, &executable, account)?
        } else {
            self.store.restore()?
        };
        let trial =
            trial.map_err(|error| format!("已执行本机配置恢复；Demo 资料恢复仍待确认：{error}"))?;
        if trial.is_some() && any_cs2_running(&self.log)? {
            return Err("游戏配置已恢复，请先退出 CS2 再完成 Demo 试播恢复。".into());
        }
        crate::demo_test::complete(&self.log, trial.as_deref())?;
        if self.store.spectator_pending() || self.store.full_spectator_pending() {
            self.log.event(
                "cs2_spectator_restore",
                "failure",
                spectator_error
                    .as_deref()
                    .or(self.store.spectator_warning().as_deref()),
            );
            self.message = Some(format!(
                "{} {}",
                if value.preserve_settings {
                    "本次受管设置已恢复，画质与帧率未接管；观战原值仍待恢复。"
                } else {
                    "帧率与画质已恢复，观战原值仍待恢复。"
                },
                spectator_error.unwrap_or_default()
            ));
        } else {
            if had_spectator {
                self.log.event(
                    "cs2_spectator_restore",
                    "success",
                    Some("stage=restore; originalField=restored"),
                );
            }
            self.message = Some(spectator_error.unwrap_or_else(|| "本地原设置已恢复。".into()));
        }

        Ok(())
    }
    pub fn poll(&mut self) {
        if let Err(error) = self.recover(false) {
            self.message = Some(error);
        }
    }
    /// A lease is bound to the held, verified game process, never just a PID.
    pub fn bind_managed_camera(
        &mut self,
        process: WorkspaceProcess,
        lease: String,
    ) -> Result<(), String> {
        if !process.is_running() || cs2_pids(&self.log)? != vec![process.pid] {
            return Err("受管游戏身份已变化，运镜会话未绑定。".into());
        }
        *self.camera.lock().map_err(|_| "运镜会话状态不可用。")? = Some(CameraLease {
            process,
            lease,
            invalidated: false,
        });
        Ok(())
    }
    pub(crate) fn camera_state(&self) -> Arc<Mutex<Option<CameraLease>>> {
        self.camera.clone()
    }
    pub(crate) fn control_live_frame_rate(
        &mut self,
        action: &str,
        limit: Option<u16>,
    ) -> Result<Value, String> {
        let log = self.log.clone();
        crate::cs2_frame_rate_live::retire_ended(&log)?;
        let pending = crate::cs2_frame_rate_live::pending(&log);
        let unsupported = |message: &str| json!({"status":"unsupported","message":message,"canApply":false,"canRestore":false,"transaction": if pending { "pending" } else { "idle" }});
        if crate::cs2_console::settings(&log)?["enabled"] != true && (action == "apply" || !pending)
        {
            return Ok(unsupported(
                "未启用本机控制台记录，请使用游戏原生设置。本操作不会开启采集。",
            ));
        }
        let Some((context, process)) = self.console_source()? else {
            return Ok(unsupported("当前没有可核验的受管游戏，请使用原生设置。"));
        };
        let Some((lease, false)) = self.managed_camera_lease() else {
            return Ok(unsupported(
                "当前控制权限不支持可靠读回，请使用游戏原生设置。",
            ));
        };
        if !context.mulnx_launch {
            return Ok(unsupported(
                "当前启动方式不支持现场帧率控制，请使用游戏原生设置。",
            ));
        }
        let executable = PathBuf::from(context.executable.as_str());
        crate::cs2_frame_rate_live::control(&log, &executable, &process, action, limit, || {
            process.is_running()
                && self.workspace_process().is_ok_and(|now| {
                    now.is_some_and(|now| now.pid == process.pid && now.created == process.created)
                })
                && self
                    .managed_camera_lease()
                    .is_some_and(|(current, invalid)| !invalid && current == lease)
        })
    }

    pub fn managed_camera_lease(&mut self) -> Option<(String, bool)> {
        let mut state = self
            .camera
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let camera = state.as_mut()?;
        if !camera.process.is_running()
            || cs2_pids(&self.log).map_or(true, |pids| pids != vec![camera.process.pid])
        {
            camera.invalidated = true;
        }
        Some((camera.lease.clone(), camera.invalidated))
    }
    pub fn invalidate_managed_camera(&mut self) {
        let mut state = self
            .camera
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(camera) = state.as_mut() {
            camera.invalidated = true;
        }
    }
    pub fn clear_managed_camera(&mut self) {
        *self
            .camera
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
    pub fn start_preparation(
        &mut self,
        preserve: bool,
        preparation_id: Option<&str>,
        guard: &crate::preparation_gate::PreparationGuard<'_>,
    ) -> Result<bool, String> {
        let journal = self.store.load()?;
        if let (Some(id), Some(existing)) = (preparation_id, journal.as_ref()) {
            if existing.preparation_id.as_deref() != Some(id) {
                return Err("已有其他游戏事务，请先完成原配置恢复。".into());
            }
        }
        if crate::demo_test::requires_recovery(&self.log, journal.as_ref())
            && crate::demo_test::status(&self.log)?["active"] == true
        {
            return Err("请先结束 Demo 试播并恢复游戏配置。".into());
        }
        self.start_internal(preserve, None, false, preparation_id, guard)
    }
    /// Prepare the same configuration transaction as Steam without submitting a launch.
    pub(crate) fn prepare_managed_mulnx(
        &mut self,
        expected: &Path,
        preserve: bool,
        preparation_id: Option<&str>,
        guard: &crate::preparation_gate::PreparationGuard<'_>,
    ) -> Result<SessionRecord, String> {
        if !self.start_internal(preserve, None, true, preparation_id, guard)? {
            return Err("请先结束现有游戏并恢复配置。".into());
        }
        let journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        if !same_executable(expected, journal.executable.as_str()) {
            return Err("游戏安装位置已变化，原配置备份仍保留。".into());
        }
        Ok(journal)
    }
    pub(crate) fn prepare_managed_mulnx_demo(
        &mut self,
        expected: &Path,
        preserve: bool,
        path: &Path,
        request_id: &str,
    ) -> Result<SessionRecord, String> {
        self.ensure_demo_available()?;
        let argument = crate::demo_test::playdemo_argument(path, &self.log)?;
        if !self.start_internal(
            preserve,
            Some((&argument, request_id)),
            true,
            None,
            &crate::preparation_gate::PreparationGuard {
                gate: None,
                id: None,
                verify: None,
                exit: None,
            },
        )? {
            return Err("请先结束现有游戏并恢复配置。".into());
        }
        let journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        if !same_executable(expected, journal.executable.as_str()) {
            return Err("游戏安装位置已变化，原配置备份仍保留。".into());
        }
        Ok(journal)
    }
    pub(crate) fn submit_managed_mulnx(&self) -> Result<(), String> {
        let mut journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        let (executable, _, _) = self.recovery_identity()?;
        if !same_executable(&executable, journal.executable.as_str()) || any_cs2_running(&self.log)?
        {
            return Err("游戏身份已变化，未提交启动。".into());
        }
        self.store.validate_video_launch()?;
        if journal.spectator_cfg {
            self.store.validate_spectator_launch()?;
            self.store.spectator_load_attempted(true)?;
        }
        journal.submit(launch_timestamp())?;
        self.store.save(&journal)
    }
    pub(crate) fn bind_managed_mulnx(
        &self,
        pid: u32,
        created: u64,
        executable: &Path,
    ) -> Result<(), String> {
        let _process = self.verified_mulnx_process(pid, created, executable)?;
        let mut journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        journal.bind(pid, created)?;
        self.store.save(&journal)?;
        self.commit_managed_source(&mut journal)
    }
    /// Window placement needs launch provenance, but does not grant gateway control
    /// or commit a telemetry source before MulNX finishes starting.
    pub(crate) fn verified_mulnx_process(
        &self,
        pid: u32,
        created: u64,
        executable: &Path,
    ) -> Result<WorkspaceProcess, String> {
        let journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        if (journal.pid().is_some() || journal.created().is_some())
            && (journal.pid() != Some(pid) || journal.created() != Some(created))
        {
            return Err("游戏已变化，请关闭游戏和 MulNX 后恢复设置。".into());
        }
        if !journal.was_submitted()
            || created
                < journal
                    .launch_time()
                    .ok_or("无法确认本次启动，请恢复设置。")?
            || cs2_pids(&self.log)? != vec![pid]
        {
            return Err("游戏启动身份不唯一。".into());
        }
        let process = open(pid, &self.log)?.ok_or("游戏已退出。")?;
        let (actual_created, actual_executable) = identity(&process, &self.log)?;
        if actual_created != created
            || !same_executable(&actual_executable, &executable.to_string_lossy())
            || !same_executable(executable, journal.executable.as_str())
        {
            return Err("游戏身份已变化，原配置备份仍保留。".into());
        }
        Ok(WorkspaceProcess::hold_verified(process, pid, created))
    }
    pub fn ensure_demo_available(&self) -> Result<(), String> {
        if self.store.load()?.is_some() || any_cs2_running(&self.log)? {
            return Err("请先退出 CS2 并恢复原配置，再开始 Demo 试播。".into());
        }
        Ok(())
    }
    pub fn start_demo(
        &mut self,
        path: &std::path::Path,
        request_id: &str,
        preserve: bool,
    ) -> Result<bool, String> {
        self.ensure_demo_available()?;
        let argument = crate::demo_test::playdemo_argument(path, &self.log)?;
        self.start_internal(
            preserve,
            Some((&argument, request_id)),
            false,
            None,
            &crate::preparation_gate::PreparationGuard {
                gate: None,
                id: None,
                verify: None,
                exit: None,
            },
        )
    }
    pub(crate) fn cancel_unsubmitted_mulnx_demo(&mut self) -> Result<(), String> {
        self.cancel_unsubmitted_mulnx()
    }
    pub(crate) fn cancel_unsubmitted_mulnx(&mut self) -> Result<(), String> {
        if self.demo_launch_attempted()? || any_cs2_running(&self.log)? {
            return Err("启动结果待确认，请先检查游戏后恢复。".into());
        }
        if let Some(launcher) = &self.mulnx_launcher {
            launcher
                .stop()
                .map_err(|_| "MulNX 启动器未能关闭，请检查后恢复。")?;
            self.mulnx_launcher = None;
        }
        if self.store.load()?.is_some() {
            self.recover(true)?;
        } else {
            let pending = self.log.state_root.join("data/mulnx-launch/pending.json");
            match std::fs::remove_file(pending) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err("MulNX 启动记录无法清理，请恢复设置。".into()),
            }
        }
        self.finish()
    }
    pub(crate) fn cancel_unsubmitted_mulnx_for(&mut self, expected: &str) -> Result<(), String> {
        if let Some(journal) = self.store.load()? {
            if !crate::preparation_gate::may_recover_mulnx_journal(
                Some(expected),
                journal.preparation_id.as_deref(),
                journal.mulnx_launch,
            ) {
                return Err("游戏事务已变化，未恢复其他启动的配置。".into());
            }
        }
        self.cancel_unsubmitted_mulnx()
    }
    pub fn demo_launch_attempted(&self) -> Result<bool, String> {
        Ok(self.store.load()?.is_some_and(|v| v.was_submitted()))
    }
    pub(crate) fn matches_pending_demo(&self, request_id: &str) -> Result<bool, String> {
        Ok(self.store.load()?.is_some_and(|v| {
            v.demo_test_request_id.as_deref() == Some(request_id)
                && v.mulnx_launch
                && v.was_submitted()
        }))
    }
    pub fn has_demo_journal(&self) -> Result<bool, String> {
        Ok(self
            .store
            .load()?
            .is_some_and(|v| v.demo_test_request_id.is_some()))
    }
    pub fn validate_demo_running(&mut self, request_id: &str) -> Result<(), String> {
        self.recover(false)?;
        let journal = self.store.load()?.ok_or("Demo 游戏启动记录已失效。")?;
        if journal.demo_test_request_id.as_deref() != Some(request_id)
            || owned_process(&journal, &self.log)?.is_none()
        {
            return Err("正在等待本次 Demo 的 CS2 启动，请稍后重试。".into());
        }
        Ok(())
    }
    fn start_internal(
        &mut self,
        preserve: bool,
        demo: Option<(&str, &str)>,
        prepare_only: bool,
        preparation_id: Option<&str>,
        guard: &crate::preparation_gate::PreparationGuard<'_>,
    ) -> Result<bool, String> {
        guard.check()?;
        if preparation_id.is_some_and(|id| !valid_preparation_id(id)) {
            return Err("启动事务标识无效。".into());
        }
        if preserve {
            self.check_preserved_start()?;
        }
        if let Some(value) = self.store.load()? {
            if owned_process(&value, &self.log)?.is_some() {
                return Ok(false);
            }
            self.recover(false)?;
            if self.store.load()?.is_some() {
                return Ok(false);
            }
        }
        if any_cs2_running(&self.log)? {
            return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
        }
        if demo.is_none() {
            self.retry_source_retire()?;
            self.retry_source_cancel()?;
        }
        let hud_recovery_warning = crate::observer_hud::prepare_launch(&self.log)?;
        if let Some(error) = &hud_recovery_warning {
            self.log.event("observer_hud", "degraded", Some(&json!({"stage":"prepare_launch", "code":"previous_record_unavailable", "error":error, "automaticHudWrites":false, "gameLaunchContinues":true}).to_string()));
        }

        let (executable, video, steam) = discover(&self.log)?;
        if any_cs2_running(&self.log)? {
            return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
        }
        self.message = None;
        let size = crate::windows_host::launch_viewport()?;
        if !prepare_only {
            steam.validate_window_options(size, false, &self.log)?;
        }
        let mut journal = if preserve {
            // The status action is only an invitation. Rediscovery above and these
            // current transaction/process checks, not an earlier failure, authorize it.
            self.check_preserved_start()?;
            steam.validate(&self.log)?;
            self.store.prepare_preserved(&video, &executable, size)?
        } else {
            self.store.backup_originals(&video)?;
            match self.store.prepare_backed_up(&video, &executable, size) {
                Ok(value) => value,
                Err(error) => {
                    self.message = Some(error.clone());
                    self.log.event(
                        "cs2_launch",
                        "failure",
                        Some(&format!("stage=prepare; {error}")),
                    );
                    return Err(if self.check_preserved_start().is_ok() {
                        "游戏设置未能自动调整。可展开“保留画质与帧率”继续，本机 HUD 仍可使用。"
                            .into()
                    } else {
                        "游戏设置准备未完成，请先恢复本次设置后重试。".into()
                    });
                }
            }
        };
        if let Some(error) = hud_recovery_warning {
            journal.hud_recovery_warning = Some(error.clone());
        }
        if prepare_only {
            journal.mulnx_launch = true;
        }
        if let Some(id) = preparation_id {
            journal.preparation_id = Some(id.to_owned());
            // Durable before any Steam or MulNX launch request is submitted.
            self.store.save(&journal)?;
        }
        if journal.spectator_cfg {
            if let Err(error) = (|| {
                self.store.validate_spectator_launch()?;
                if journal.native_hud_toggle {
                    let identity = journal.hud_identity.as_deref().ok_or("HUD 键身份缺失。")?;
                    if self.store.spectator_hud_identity()?.as_deref() != Some(identity) {
                        return Err("HUD 键身份记录不一致。".into());
                    }
                }
                Ok::<(), String>(())
            })() {
                let warning = format!("观战 CFG 核验失败，未提交启动：{error}");
                journal.spectator_warning = Some(warning.clone());
                self.store.save(&journal)?;
                return Err(warning);
            }
        }
        if !preserve {
            self.log.event(
                "cs2_spectator_cfg",
                if journal.spectator_cfg || journal.full_snapshot {
                    "success"
                } else {
                    "failure"
                },
                Some(
                    &json!({"stage":"prepared", "file":if journal.full_snapshot { None } else { Some(crate::cs2_spectator::CFG_NAME) },
                    "runtime":"unverified", "reason":journal.spectator_warning})
                    .to_string(),
                ),
            );
        }
        if let Some((argument, request_id)) = demo {
            journal.demo_test_request_id = Some(request_id.to_owned());
            journal.demo_playback_cfg = crate::demo_test::playback_cfg_plan(request_id, argument)?;
            self.store.save(&journal)?;
            if let Err((error, created)) = crate::demo_test::install_playback_cfg(&journal.value())
            {
                // A create_new collision never grants ownership of an existing file.
                // Keep core configuration recovery available after a refused install.
                if !created {
                    journal.demo_playback_cfg = Value::Null;
                } else {
                    journal.demo_playback_cfg_error = Some(error.clone());
                }
                self.store.save(&journal)?;
                return Err(error);
            }
        }
        match crate::cs2_console::prepare(&self.log, &executable) {
            Ok(Some(prepared)) => journal.console_diagnostics = prepared,
            Ok(None) => (),
            Err(error) => {
                // Optional evidence must not gate gameplay. Keep the old raw file
                // untouched and disable this launch's capture, including MulNX.
                journal.console_diagnostics = Value::Null;
                let code = if error.starts_with("raw_console_preservation_failed:") {
                    "raw_preservation_failed"
                } else {
                    "source_prepare_failed"
                };
                self.log.event("cs2_console_prepare", "failure", Some(&json!({"error":error,"code":code,"condebugRequested":false,"gameLaunchContinues":true}).to_string()));
                journal.console_diagnostics_warning = json!({"code":code,"error":error});
            }
        }
        self.store.save(&journal)?;
        let source_uninstalled = if demo.is_none() {
            match self.store.gsi_is_uninstalled(&journal) {
                Ok(value) => value,
                Err(error) => {
                    if let Err(recovery) = self.recover(false) {
                        return Err(format!("{error}；配置恢复待处理：{recovery}"));
                    }
                    return Err(error);
                }
            }
        } else {
            true
        };
        if demo.is_none() && !source_uninstalled {
            let request_id = preparation_id.map(str::to_owned).unwrap_or_else(|| {
                format!(
                    "managed-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
            });
            journal.managed_source_request_id = Some(request_id.clone());
            self.store.save(&journal)?;
            let mut request = json!({"action":"prepare","requestId":request_id});
            if let Some(id) = preparation_id {
                request["preparationId"] = json!(id);
            }
            let source = (|| -> Result<(String, String, String), String> {
                let prepared = crate::production_exit::managed_source_request(&self.log, request)?;
                Ok((
                    prepared["ticket"]
                        .as_str()
                        .ok_or("受管来源资格无效。")?
                        .to_owned(),
                    prepared["sourceId"]
                        .as_str()
                        .ok_or("受管来源资格无效。")?
                        .to_owned(),
                    prepared["gsiUri"]
                        .as_str()
                        .ok_or("受管来源资格无效。")?
                        .to_owned(),
                ))
            })();
            let (ticket, source_id, uri) = match source {
                Ok(source) => source,
                Err(error) => {
                    if let Err(recovery) = self.recover(false) {
                        return Err(format!("{error}；配置恢复待处理：{recovery}"));
                    }
                    return Err(error);
                }
            };
            if let Err(error) =
                self.store
                    .prepare_gsi_source(&mut journal, &ticket, &source_id, &uri)
            {
                let _ = crate::production_exit::managed_source_request(
                    &self.log,
                    json!({"action":"cancel","ticket":ticket}),
                );
                // The source plan is durable before touching GSI. Restore any
                // partially applied config before returning the launch error.
                if let Err(recovery) = self.recover(false) {
                    return Err(format!("{error}；配置恢复待处理：{recovery}"));
                }
                return Err(error);
            }
        }
        if prepare_only {
            return Ok(true);
        }
        let launch: Result<bool, String> = (|| {
            // Recheck the same process and current account before committing a
            // request. A refused check remains an unlaunched, recoverable journal.
            steam.validate(&self.log)?;
            if any_cs2_running(&self.log)? {
                return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
            }
            let mut command = steam.command(size)?;
            if !preserve {
                command.args([
                    "+fps_max",
                    &journal
                        .frame_rate_limit
                        .ok_or("帧率启动参数缺失。")?
                        .to_string(),
                ]);
            }
            if journal.spectator_cfg {
                match self.store.spectator_load_attempted(true) {
                    Ok(()) => {
                        let cfg = if journal.native_hud_toggle {
                            crate::cs2_spectator::hud_cfg_name(
                                journal.hud_identity.as_deref().unwrap_or(""),
                            )?
                        } else {
                            crate::cs2_spectator::CFG_NAME
                        };
                        command.args(["+exec", cfg]);
                    }
                    Err(error) => {
                        let warning = format!("观战 CFG 核验失败，未提交启动：{error}");
                        journal.spectator_warning = Some(warning.clone());
                        self.store.save(&journal)?;
                        self.log.event("cs2_spectator_cfg", "failure", Some(&json!({"stage":"prepared", "file":crate::cs2_spectator::CFG_NAME, "runtime":"unverified", "reason":journal.spectator_warning}).to_string()));
                        return Err(warning);
                    }
                }
            }

            if journal.console_diagnostics["version"] == 1 {
                match crate::cs2_console::settings(&self.log) {
                    Ok(config)
                        if config["enabled"] == true
                            && config["generation"]
                                == journal.console_diagnostics["generation"] =>
                    {
                        command.arg("-condebug");
                    }
                    result => {
                        self.log.event("cs2_console_prepare", "interrupted", Some(&json!({"reason":"consent_changed_before_launch","current":format!("{result:?}"),"condebugRequested":false}).to_string()));
                        journal.console_diagnostics = Value::Null;
                    }
                }
            }
            if demo.is_some() {
                command.args([
                    "+exec",
                    journal.demo_playback_cfg["name"]
                        .as_str()
                        .ok_or("Demo 播放 CFG 名称缺失。")?,
                ]);
            }
            self.log.event("cs2_launch_arguments", "begin", Some(&json!({
                "program": command.get_program().to_string_lossy(),
                "arguments": command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect::<Vec<_>>(),
                "preserveSettings": preserve, "runtime":"unverified",
                "argumentsScope":"requested-steam-command",
                "steamInheritedArguments":"unobserved", "actualGameArguments":"unobserved"
            }).to_string()));
            // Recheck the account, saved Steam arguments and key identity before submission.
            steam.validate_window_options(
                size,
                !journal.console_diagnostics_warning.is_null(),
                &self.log,
            )?;
            if any_cs2_running(&self.log)? {
                return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
            }
            if journal.spectator_cfg {
                self.store.validate_spectator_launch()?;
            }
            self.store.validate_video_launch()?;
            // Commit the ambiguous-launch marker only after all checks and
            // argument validation, immediately before sending the Steam request.
            let launch_time = launch_timestamp();
            journal.submit(launch_time)?;
            guard.commit(|| {
                self.store.save(&journal)?;
                submit_steam(&mut command).map_err(|error| {
                    self.log.event(
                        "cs2_launch",
                        "failure",
                        Some(&format!(
                        "stage=steam_spawn; launchTime={launch_time}; code={:?}; cause={error:?}",
                        error.raw_os_error()
                    )),
                    );
                    journal.submission_failed();
                    if journal.spectator_cfg {
                        if let Err(error) = self.store.spectator_load_attempted(false) {
                            self.log
                                .event("cs2_spectator_restore", "failure", Some(&error));
                        }
                    }
                    if let Err(save_error) = self.store.save(&journal) {
                        self.log.event(
                            "cs2_launch",
                            "failure",
                            Some(&format!(
                                "stage=journal_after_spawn_failure; cause={save_error}"
                            )),
                        );
                    }
                    "CS2 未能启动。"
                })?;
                Ok(())
            })?;
            // Steam's launcher PID is not the game PID. Commit the pending
            // request and release the command lock; the existing background poll
            // adopts only a unique new process from the selected installation.
            self.launch_observation = None;
            self.message = Some("Steam 启动请求已提交，正在等待 CS2。启动较慢时会继续跟踪；如需取消，请先取消 Steam 启动请求，再恢复备份。".into());
            self.log.event(
                "cs2_launch",
                "success",
                Some(&format!(
                    "stage=steam_request_submitted; launchTime={launch_time}"
                )),
            );
            // Child is intentionally outside Companion's Runtime Job. Never kill
            // by name; the durable PID + creation time + executable owns cleanup.
            Ok(true)
        })();
        self.complete_launch(launch, demo.is_some())
    }
    fn complete_launch(
        &mut self,
        launch: Result<bool, String>,
        is_demo: bool,
    ) -> Result<bool, String> {
        if let Err(error) = &launch {
            self.message = Some(error.clone());
            if let Err(recovery_error) = if !is_demo {
                self.recover(false)
            } else {
                Ok(())
            } {
                self.log.event(
                    "cs2_launch",
                    "failure",
                    Some(&format!(
                        "stage=failed_launch_recovery; original={error}; cause={recovery_error}"
                    )),
                );
            }
        }
        launch
    }
    pub fn backup_directory(&self) -> PathBuf {
        self.store.backup_directory()
    }
    fn require_backup_idle(&self) -> Result<(), String> {
        if self.store.load()?.is_some()
            || self.store.spectator_pending()
            || crate::demo_test::requires_recovery(&self.log, None)
        {
            return Err("请先结束工作台并完成上次配置恢复。".into());
        }
        if any_cs2_running(&self.log)? {
            return Err("请先退出 CS2，再选择恢复备份。".into());
        }
        Ok(())
    }
    pub fn cancel_selected_backup(&mut self) {
        self.selected_backup = None;
    }
    pub fn select_backup(&mut self, source: &std::path::Path) -> Result<BackupSelection, String> {
        self.selected_backup = None;
        self.require_backup_idle()?;
        let (executable, video, steam) = discover(&self.log)?;
        let source = std::fs::canonicalize(source)
            .map_err(|e| crate::cs2_session::io_error("备份路径无法读取。", &e))?;
        let backup = backup_text(&source, 128 * 1024)?;
        let original = backup_text(&video, 128 * 1024)?;
        crate::cs2_video::compatible_restore(&backup, &original)?;
        let account_id = (76561197960265728u64 + u64::from(steam.account)).to_string();
        let steam_root = steam.directory()?;
        let users = backup_text(&steam_root.join("config/loginusers.vdf"), 1024 * 1024)?;
        let nickname = crate::cs2_frame_rate::field(&users, &["users", &account_id, "PersonaName"])
            .map_err(|error| format!("loginusers.vdf / 读取账号昵称：{error}"))?
            .map(|v| v.value)
            .filter(|v| !v.trim().is_empty())
            .ok_or("当前 Steam 昵称无法读取，请重新登录 Steam 后再试。")?;
        let avatar =
            backup_avatar(&steam_root.join(format!("config/avatarcache/{account_id}.png")));
        let mut frame = None;
        // Only a named snapshot offers a sibling convars file. A loose .bak
        // never silently selects an unrelated live convars file beside it.
        if source.file_name().is_some_and(|n| n == "cs2_video.txt") {
            let candidate = source.with_file_name("cs2_machine_convars.vcfg");
            match std::fs::symlink_metadata(&candidate) {
                Ok(_) => {
                    let selected = backup_text(&candidate, 256 * 1024)?;
                    let before = backup_text(
                        &video.with_file_name("cs2_machine_convars.vcfg"),
                        256 * 1024,
                    )?;
                    crate::cs2_frame_rate::compatible_restore(&selected, &before)?;
                    frame = Some(json!({"source":candidate,"backup":selected,"original":before}));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => {
                    return Err(crate::cs2_session::io_error(
                        "备份中的帧率文件无法读取。",
                        &e,
                    ))
                }
            }
        }
        steam.validate(&self.log)?;
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间不可用。")?
            .as_nanos()
            .to_string();
        let preview = BackupSelection {
            selection_id: id.clone(),
            nickname,
            avatar,
            source_name: source
                .file_name()
                .ok_or("备份文件名无法读取。")?
                .to_string_lossy()
                .into_owned(),
            target_path: video.to_str().ok_or("配置路径无法读取。")?.to_owned(),
            includes_frame_rate: frame.is_some(),
        };
        self.selected_backup = Some(
            json!({"id":id,"source":source,"backup":backup,"original":original,
            "video":video,"executable":executable,"account":steam.account,"frame":frame}),
        );
        Ok(preview)
    }
    pub fn apply_selected_backup(&mut self, id: &str) -> Result<(), String> {
        self.require_backup_idle()?;
        let selection = self
            .selected_backup
            .as_ref()
            .ok_or("请先选择备份并核对目标账号。")?;
        if selection["id"] != id {
            return Err("备份选择已变化，请重新核对。".into());
        }
        let (executable, video, steam) = discover(&self.log)?;
        if selection["account"].as_u64() != Some(u64::from(steam.account))
            || selection["video"] != json!(video)
            || selection["executable"] != json!(executable)
        {
            return Err("Steam 账号或配置位置已变化，请重新选择备份。".into());
        }
        let backup = selection["backup"].as_str().ok_or("备份内容缺失。")?;
        let original = selection["original"].as_str().ok_or("当前配置记录缺失。")?;
        let source = std::path::Path::new(selection["source"].as_str().ok_or("备份路径缺失。")?);
        if backup_text(source, 128 * 1024)? != backup {
            return Err("所选备份已变化，请重新选择。".into());
        }
        let frame = if selection["frame"].is_object() {
            let v = &selection["frame"];
            let selected = v["backup"].as_str().ok_or("帧率备份缺失。")?;
            if backup_text(
                std::path::Path::new(v["source"].as_str().ok_or("帧率备份路径缺失。")?),
                256 * 1024,
            )? != selected
            {
                return Err("帧率备份已变化，请重新选择。".into());
            }
            Some((
                v["original"].as_str().ok_or("原始帧率记录缺失。")?,
                selected,
            ))
        } else {
            None
        };
        steam.validate(&self.log)?;
        if any_cs2_running(&self.log)? {
            return Err("CS2 已启动，请退出游戏后重试。".into());
        }
        self.store
            .import_selected_backup(&video, &executable, backup, original, frame)?;
        self.selected_backup = None;
        self.message = Some("所选设置已恢复，恢复前的原件已保存。".into());
        Ok(())
    }
    pub fn restore_backup(&mut self, confirm_steam_cancelled: bool) -> Result<(), String> {
        self.restore_backup_inner(confirm_steam_cancelled, true)
    }
    fn restore_backup_for_start(&mut self) -> Result<(), String> {
        self.restore_backup_inner(false, false)
    }
    fn restore_backup_inner(
        &mut self,
        confirm_steam_cancelled: bool,
        require_playback_cleanup: bool,
    ) -> Result<(), String> {
        let result = self.recover(confirm_steam_cancelled).and_then(|_| {
            if self.store.load()?.is_none() && self.store.spectator_pending() {
                if self.store.mulnx_observer_unconfirmed()? {
                    if !confirm_steam_cancelled {
                        return Err(
                            "MulNX 启动结果待确认，请先关闭 MulNX 启动器及 CS2，再确认恢复。"
                                .into(),
                        );
                    }
                    if !process_pids("CS2Injector.exe", &self.log)?.is_empty() {
                        return Err("MulNX 启动器仍在运行，观战备份仍保留。".into());
                    }
                }
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                if self.store.mulnx_observer_target()?.is_some()
                    && !process_pids("CS2Injector.exe", &self.log)?.is_empty()
                {
                    return Err("MulNX 启动器仍在运行，观战备份仍保留。".into());
                }
                if let Some((video, executable, account)) = self.store.mulnx_observer_target()? {
                    let (current_exe, current_video, current_account) = self.recovery_identity()?;
                    let saved_video = fs::canonicalize(&video)
                        .map_err(|e| crate::cs2_session::io_error("观战恢复目标无法确认。", &e))?;
                    let live_video = fs::canonicalize(&current_video)
                        .map_err(|e| crate::cs2_session::io_error("当前账号目标无法确认。", &e))?;
                    let saved_exe = fs::canonicalize(&executable)
                        .map_err(|e| crate::cs2_session::io_error("观战程序无法确认。", &e))?;
                    let live_exe = fs::canonicalize(&current_exe)
                        .map_err(|e| crate::cs2_session::io_error("当前程序无法确认。", &e))?;
                    if current_account != account
                        || saved_video != live_video
                        || saved_exe != live_exe
                    {
                        return Err("请登录原 Steam 账号并确认原游戏安装位置后再恢复。".into());
                    }
                    // A crash can leave +exec in MulNX even after a game PID was recorded.
                    // Reconcile the owned launch option before clearing the key backup.
                    crate::production_exit::cleanup_mulnx(&self.log, &executable, None)
                        .map_err(|e| format!("MulNX 启动参数未能清理，观战备份仍保留：{e}"))?;
                    self.store.mark_mulnx_options_clean()?;
                    if any_cs2_running(&self.log)?
                        || !process_pids("CS2Injector.exe", &self.log)?.is_empty()
                    {
                        return Err("游戏或 MulNX 启动器正在运行，观战备份仍保留。".into());
                    }
                }
                if let Err(error) = self.store.restore_spectator() {
                    self.log
                        .event("cs2_spectator_restore", "failure", Some(&error));
                    return Err(error);
                }
                self.log.event(
                    "cs2_spectator_restore",
                    "success",
                    Some("stage=retry; originalField=restored"),
                );
                self.message = Some("观战原值已恢复。".into());
            }
            if self.store.load()?.is_none() && self.store.full_spectator_pending() {
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                let (executable, video, account) = self.recovery_identity()?;
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                if let Some(warning) =
                    self.store
                        .restore_full_pending(&video, &executable, account)?
                {
                    self.message = Some(warning.clone());
                    return Err(warning);
                }
                self.message = Some("本地观战原值已恢复。".into());
            }
            if self.store.load()?.is_none() && self.store.playback_cleanup_pending() {
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再清理试播文件。".into());
                }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再清理试播文件。".into());
                }
                match self.store.restore_playback_cleanup() {
                    Ok(()) => self.message = Some("原设置已恢复，试播文件已清理。".into()),
                    Err(error) => {
                        self.log
                            .event("demo_playback_cleanup", "failure", Some(&error));
                        if require_playback_cleanup {
                            return Err(error);
                        }
                        // Core/spectator recovery, pending Steam/MulNX requests,
                        // and Demo data isolation still gate a normal start.
                        self.check_preserved_start()?;
                        if crate::demo_test::requires_recovery(&self.log, None) {
                            return Err(error);
                        }
                        self.log.event(
                            "demo_playback_cleanup",
                            "retained",
                            Some(
                                &json!({
                                    "reason":error,"gameLaunchContinues":true,
                                    "files":"unchanged; cleanup can be retried after game exit"
                                })
                                .to_string(),
                            ),
                        );
                        self.message = Some(
                            "原设置已恢复；旧试播文件仍保留，可稍后重试清理，不影响新启动。".into(),
                        );
                    }
                }
            }
            Ok(())
        });
        if let Err(error) = &result {
            self.message = Some(error.clone());
        }
        result
    }
    /// A restored or absent journal alone does not prove external CS2 has stopped.
    pub fn confirm_game_stopped(&self) -> Result<(), String> {
        if any_cs2_running(&self.log)? {
            return Err("CS2 仍在运行，本场回收资格未确认。请退出游戏后重试结束游戏。".into());
        }
        Ok(())
    }

    /// Read-only feedback retirement; absent journal alone is not a stop proof.
    pub fn window_session_finished(&self) -> Result<bool, String> {
        Ok(self.store.load()?.is_none() && !any_cs2_running(&self.log)?)
    }

    pub fn finish(&mut self) -> Result<(), String> {
        self.finish_with_service_stopped(false)
    }
    /// Only the verified service-stop path can skip the lease expiry wait.
    pub fn finish_with_service_stopped(&mut self, service_stopped: bool) -> Result<(), String> {
        self.finish_with_guard(
            service_stopped,
            &crate::preparation_gate::PreparationGuard {
                gate: None,
                id: None,
                verify: None,
                exit: None,
            },
        )
    }
    fn finish_with_guard(
        &mut self,
        service_stopped: bool,
        guard: &crate::preparation_gate::PreparationGuard<'_>,
    ) -> Result<(), String> {
        let trial_status = if crate::demo_test::requires_recovery(&self.log, None) {
            crate::demo_test::status(&self.log)
        } else {
            Ok(Value::Null)
        };
        let unknown_trial = Value::Null;
        let trial_state = trial_status.as_ref().unwrap_or(&unknown_trial);
        if trial_state["active"] == true && trial_state["gameOwnership"] == "external" {
            if self.store.load()?.is_some() || self.store.spectator_pending() {
                return Err("请先完成受管游戏的配置恢复。".into());
            }
            // Read-only migration of an old external Demo marker. No new external
            // session can be created, and this marker never grants game ownership.
            crate::production_exit::disconnect_camera(&self.log)?;
            let trial = crate::demo_test::quarantine(&self.log)?;
            crate::demo_test::complete(&self.log, trial.as_deref())?;
            self.message = Some("试播已结束，游戏保持运行。".into());
            return Ok(());
        }
        if crate::cs2_frame_rate_live::pending(&self.log) && !service_stopped {
            // Restore before revoking the live lease. An unknown result is not
            // replayed; normal owned-process exit can still safely proceed.
            let result = crate::cs2_frame_rate_live::finish_restore(|| {
                self.control_live_frame_rate("restore", None)
            });
            self.log
                .native_outcome("cs2_frame_rate_finish_restore", None, &result);
        }
        if let Some((lease, _)) = self.managed_camera_lease() {
            // Mark under the camera lock after any in-flight pulse, before revocation.
            self.invalidate_managed_camera();
            let outcome = retire_camera_before_cleanup(
                service_stopped,
                || {
                    crate::production_exit::camera_session(
                        &self.log,
                        "invalidate",
                        Some(&lease),
                        None,
                    )
                    .map(|_| ())
                },
                || thread::sleep(Duration::from_millis(12100)),
            );
            self.log.event("managed_camera_retire", outcome, None);
            self.clear_managed_camera();
        }
        let journal = self.store.load()?;
        let trial = crate::demo_test::quarantine_if_needed(&self.log, journal.as_ref());
        // Poll once to adopt a uniquely identified late launch before closing it.
        self.poll();
        if let Some(value) = self.store.load()? {
            if let Some(process) = owned_process(&value, &self.log)? {
                // Every owned-game exit, including application shutdown and a
                // failed workbench entry, must pass the same MulNX unload fence.
                // External sessions have already returned through detach above.
                let result = crate::production_exit::finish_then_restore(
                    || {
                        self.log.step("cs2_exit_mulnx_unload", || {
                            crate::mulnx_launch::stop_managed_for_exit(self, &self.log)
                        })
                    },
                    || guard.commit(|| process.close(&self.log)),
                );
                if let Err(error) = result {
                    self.message = Some(error.clone());
                    return Err(error);
                }
            }
        }
        // The held launcher handle can cancel our pending MulNX request after
        // game exit. A bare journal/PID, including after Host restart, cannot.
        let cancel_pending_mulnx = self.mulnx_launcher.is_some()
            && self
                .log
                .state_root
                .join("data/mulnx-launch/pending.json")
                .exists();
        if let Some(launcher) = &self.mulnx_launcher {
            stop_owned_launcher(
                || any_cs2_running(&self.log),
                || {
                    launcher.stop().map_err(|error| {
                        self.log.preserve_error(
                            "mulnx_launcher_exit",
                            None,
                            &error,
                            "本次 MulNX 启动器未能关闭，请检查后重试。".to_string(),
                        )
                    })
                },
            )?;
            self.log.event(
                "mulnx_launcher_exit",
                "success",
                Some("owned launch handle stopped after game exit"),
            );
        }
        if !cancel_pending_mulnx
            && self
                .store
                .load()?
                .as_ref()
                .is_some_and(SessionRecord::unconfirmed_launch)
        {
            return Err(
                "Steam 启动仍在等待。请先取消 Steam 启动请求，并确认 CS2 已关闭，再恢复备份。"
                    .into(),
            );
        }
        match self.recover(cancel_pending_mulnx) {
            Ok(()) => {
                self.mulnx_launcher = None;
                let trial = trial?;
                if trial.is_some() && any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2，再完成 Demo 试播恢复。".into());
                }
                crate::demo_test::complete(&self.log, trial.as_deref())
            }
            Err(error) => {
                self.message = Some(error.clone());
                Err(error)
            }
        }
    }
}
fn stop_owned_launcher(
    game_running: impl FnOnce() -> Result<bool, String>,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if game_running()? {
        return Err("CS2 仍在运行，未关闭本次 MulNX 启动器。".into());
    }
    stop()
}

/// A failed request does not prove revocation. With renewals fenced by the
/// caller's mutex, wait for two lease periods: at most one timed-out pulse can
/// still arrive before the current lease expires and extend it once. A verified
/// stopped service has no live lease.
fn retire_camera_before_cleanup(
    service_stopped: bool,
    revoke: impl FnOnce() -> Result<(), String>,
    wait_for_expiry: impl FnOnce(),
) -> &'static str {
    if service_stopped {
        return "service-stopped";
    }
    if revoke().is_ok() {
        return "revoked";
    }
    wait_for_expiry();
    "expired-after-unknown"
}

fn backup_text(path: &std::path::Path, limit: usize) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| crate::cs2_session::io_error("配置文件无法读取。", &e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err("配置文件类型或大小不支持。".into());
    }
    let value = std::fs::read_to_string(path)
        .map_err(|e| crate::cs2_session::io_error("配置内容无法读取。", &e))?;
    if value.len() > limit {
        return Err("配置内容过大。".into());
    }
    Ok(value)
}
fn backup_avatar(path: &std::path::Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 256 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::from("data:image/png;base64,");
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        encoded.push(B64[((n >> 18) & 63) as usize] as char);
        encoded.push(B64[((n >> 12) & 63) as usize] as char);
        encoded.push(if group.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        encoded.push(if group.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    Some(encoded)
}
