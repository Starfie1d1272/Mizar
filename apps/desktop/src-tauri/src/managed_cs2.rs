use crate::cs2_session::SessionStore;
use serde_json::{json, Value};
use std::{
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

pub const LAUNCH_ARGS: &[&str] = &[
    "-applaunch",
    "730",
    "-windowed",
    "-noborder",
    "-console",
    "-allow_third_party_software",
    "-worldwide",
];

const DISCOVERY: &str = include_str!("../../../../scripts/qualification/bundle/gsi-discovery.ps1");

// Fixed scripts only: no paths supplied by the webview are interpolated as code.
fn powershell(
    body: &str,
    steam: &SteamProcess,
    expected_account: Option<u32>,
    log: &crate::startup_log::DesktopLog,
) -> Result<String, String> {
    steam.validate(log)?;
    let discovery = DISCOVERY.trim_start_matches('\u{feff}');
    let script = format!(
        r#"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
{discovery}
trap {{
  [Console]::Error.WriteLine(($_ | Format-List * -Force | Out-String))
  $code = [string]$_.Exception.Data['MizarCode']
  if (-not $code) {{ $code = 'operation-failed' }}
  @{{error=@{{code=$code;stage='launch'}}}} | ConvertTo-Json -Compress
  exit 1
}}
$nativeSteam = $env:MIZAR_NATIVE_STEAM | ConvertFrom-Json
{body}
"#
    );
    let system = std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?;
    let executable = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(executable);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000);
    // Paths are data in a private child environment, never PowerShell source.
    command.env(
        "MIZAR_NATIVE_STEAM",
        json!({"pid": steam.pid, "executable": steam.executable, "account": expected_account})
            .to_string(),
    );
    let output = crate::powershell::run(command, log, "CS2 启动配置检测", Duration::from_secs(15))?;
    steam.validate(log)?;
    Ok(output)
}

fn any_cs2_running(log: &crate::startup_log::DesktopLog) -> Result<bool, String> {
    Ok(!cs2_pids(log)?.is_empty())
}

struct SteamLaunch {
    process: SteamProcess,
    account: u32,
}
impl SteamLaunch {
    fn validate(&self, log: &crate::startup_log::DesktopLog) -> Result<(), String> {
        let output = powershell(
            "$context = Get-SteamLaunchContext -NativeIdentity $nativeSteam; $context | ConvertTo-Json -Compress",
            &self.process,
            Some(self.account),
            log,
        )?;
        let value = crate::powershell::parse(log, "Steam 启动身份复核", &output)?;
        if value["account"].as_u64() != Some(u64::from(self.account)) {
            return Err(steam_failure(log, "steam-account-unavailable"));
        }
        Ok(())
    }
}

fn discover(
    log: &crate::startup_log::DesktopLog,
) -> Result<(PathBuf, PathBuf, SteamLaunch), String> {
    let steam = SteamProcess::discover(log)?;
    let script = r#"
$cfg = Resolve-CfgDirectory
$game = Split-Path (Split-Path $cfg -Parent) -Parent
$exe = Join-Path $game 'bin\win64\cs2.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { Stop-Cs2Discovery 'selected-path-invalid' }
$steamContext = Get-SteamLaunchContext -NativeIdentity $nativeSteam
$steamExe = $steamContext.executable
$account = $steamContext.account
$videos = @()
foreach ($root in @(Get-UniqueSteamPaths (@((Split-Path -Parent $steamExe)) + @(Get-SteamInstallRoots)))) {
  $candidate = Join-Path $root ('userdata\' + $account + '\730\local\cfg\cs2_video.txt')
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $videos += (Resolve-Path -LiteralPath $candidate).Path }
}
$videos = @($videos | Select-Object -Unique)
if ($videos.Count -eq 0) { Stop-Cs2Discovery 'video-config-missing' }
if ($videos.Count -ne 1) { Stop-Cs2Discovery 'video-config-ambiguous' }
$confirmed = Get-SteamLaunchContext -NativeIdentity $nativeSteam
if ($confirmed.account -ne $account) { Stop-Cs2Discovery 'steam-account-unavailable' }
@{executable=(Resolve-Path -LiteralPath $exe).Path; video=$videos[0]; account=$account} | ConvertTo-Json -Compress
"#;
    let output = powershell(script, &steam, None, log)?;
    let value = crate::powershell::parse(log, "CS2 启动配置检测", &output)?;
    let path = |key: &str| {
        value[key]
            .as_str()
            .map(PathBuf::from)
            .ok_or_else(|| "CS2 配置路径缺失。".to_string())
    };
    let account = value["account"]
        .as_u64()
        .and_then(|account| u32::try_from(account).ok())
        .filter(|account| *account != 0)
        .ok_or_else(|| steam_failure(log, "steam-account-unavailable"))?;
    Ok((
        path("executable")?,
        path("video")?,
        SteamLaunch {
            process: steam,
            account,
        },
    ))
}

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}
type Handle = isize;
#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    executable: [u16; 260],
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetLastError() -> u32;
    fn GetProcessTimes(
        handle: Handle,
        created: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn QueryFullProcessImageNameW(
        handle: Handle,
        flags: u32,
        name: *mut u16,
        length: *mut u32,
    ) -> i32;
    fn GetSystemTimeAsFileTime(time: *mut FileTime);
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
}
#[link(name = "user32")]
extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(isize, isize) -> i32, data: isize) -> i32;
    fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
    fn PostMessageW(window: isize, message: u32, wparam: usize, lparam: isize) -> i32;
}

struct Process(Handle);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn cs2_pids(log: &crate::startup_log::DesktopLog) -> Result<Vec<u32>, String> {
    process_pids("cs2.exe", log)
}
fn process_pids(name: &str, log: &crate::startup_log::DesktopLog) -> Result<Vec<u32>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snapshot == -1 {
        return Err(win32_failure(
            log,
            "CreateToolhelp32Snapshot",
            "无法检查启动进程，未修改游戏设置。",
        ));
    }
    let snapshot = Process(snapshot);
    let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut pids = Vec::new();
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while found != 0 {
        let len = entry.executable.iter().position(|v| *v == 0).unwrap_or(260);
        if String::from_utf16_lossy(&entry.executable[..len]).eq_ignore_ascii_case(name) {
            pids.push(entry.pid);
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != 18 {
        return Err(win32_failure(log, "Process32NextW", "启动进程检查未完成。"));
    }
    Ok(pids)
}
fn open(pid: u32, log: &crate::startup_log::DesktopLog) -> Result<Option<Process>, String> {
    let handle = unsafe { OpenProcess(0x1000 | 0x100000, 0, pid) };
    if handle != 0 {
        Ok(Some(Process(handle)))
    } else if unsafe { GetLastError() } == 87 {
        Ok(None)
    } else {
        Err(win32_failure(
            log,
            "OpenProcess",
            "无法确认进程身份，未关闭游戏或恢复配置。",
        ))
    }
}
fn identity(
    process: &Process,
    log: &crate::startup_log::DesktopLog,
) -> Result<(u64, PathBuf), String> {
    let mut created = FileTime::default();
    let mut exit = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    if unsafe { GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(win32_failure(
            log,
            "GetProcessTimes",
            "无法确认进程创建时间。",
        ));
    }
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err(win32_failure(
            log,
            "QueryFullProcessImageNameW",
            "无法确认进程程序路径。",
        ));
    }
    Ok((
        ((created.high as u64) << 32) | created.low as u64,
        PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])),
    ))
}
fn win32_failure(log: &crate::startup_log::DesktopLog, api: &str, message: &str) -> String {
    let code = unsafe { GetLastError() };
    log.event(
        "cs2_launch",
        "failure",
        Some(&format!(
            "source=Win32; api={api}; code={code}; cause={}",
            std::io::Error::from_raw_os_error(code as i32)
        )),
    );
    message.into()
}

// The held handle binds every observation to the original Steam process, even
// if it exits and its PID is reused. Registry install paths cannot prove this.
struct SteamProcess {
    process: Process,
    pid: u32,
    created: u64,
    executable: PathBuf,
}
fn steam_failure(log: &crate::startup_log::DesktopLog, code: &str) -> String {
    log.event(
        "cs2_launch",
        "failure",
        Some(&format!("stage=steam_identity; code={code}")),
    );
    match code {
        "steam-not-running" => "请先打开 Steam 并登录，再启动 CS2。",
        "steam-not-unique" => "Steam 进程不唯一，无法确认启动位置。",
        "steam-account-unavailable" => "Steam 当前账号不可用或已变化，请确认登录后重试。",
        _ => "Steam 程序位置不可用或进程已变化，请确认 Steam 状态后重试。",
    }
    .into()
}
impl SteamProcess {
    fn discover(log: &crate::startup_log::DesktopLog) -> Result<Self, String> {
        let pids = process_pids("steam.exe", log)?;
        let pid = match pids.as_slice() {
            [] => return Err(steam_failure(log, "steam-not-running")),
            [pid] => *pid,
            _ => return Err(steam_failure(log, "steam-not-unique")),
        };
        let process =
            open(pid, log)?.ok_or_else(|| steam_failure(log, "steam-path-unavailable"))?;
        let (created, executable) = identity(&process, log)?;
        if !executable
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("steam.exe"))
        {
            return Err(steam_failure(log, "steam-path-unavailable"));
        }
        let steam = Self {
            process,
            pid,
            created,
            executable,
        };
        steam.validate(log)?;
        Ok(steam)
    }
    fn validate(&self, log: &crate::startup_log::DesktopLog) -> Result<(), String> {
        let pids = process_pids("steam.exe", log)?;
        if pids.len() > 1 {
            return Err(steam_failure(log, "steam-not-unique"));
        }
        if pids.as_slice() != [self.pid] || unsafe { WaitForSingleObject(self.process.0, 0) } != 258
        {
            return Err(steam_failure(log, "steam-path-unavailable"));
        }
        let (created, executable) = identity(&self.process, log)?;
        if created != self.created
            || !same_executable(&executable, &self.executable.to_string_lossy())
        {
            return Err(steam_failure(log, "steam-path-unavailable"));
        }
        Ok(())
    }
}

fn same_executable(actual: &std::path::Path, expected: &str) -> bool {
    let normalize = |path: &std::path::Path| {
        crate::powershell::provider_path(path)
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    normalize(actual) == normalize(std::path::Path::new(expected))
}

fn owned_process(
    value: &Value,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<Process>, String> {
    let Some(pid) = value["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return Ok(None);
    };
    let Some(process) = open(pid, log)? else {
        return Ok(None);
    };
    match unsafe { WaitForSingleObject(process.0, 0) } {
        0 => return Ok(None),
        258 => (),
        _ => {
            return Err(win32_failure(
                log,
                "WaitForSingleObject",
                "无法确认 CS2 是否退出，备份仍保留。",
            ))
        }
    }
    let (created, executable) = identity(&process, log)?;
    let expected = value["executable"]
        .as_str()
        .ok_or("CS2 进程路径记录缺失。")?;
    if value["created"].as_u64() != Some(created) || !same_executable(&executable, expected) {
        return Ok(None);
    }
    Ok(Some(process))
}
fn launched_process(
    value: &Value,
    log: &crate::startup_log::DesktopLog,
) -> Result<(Option<(u32, u64)>, Value), String> {
    let launch_time = value["launchTime"]
        .as_u64()
        .ok_or("CS2 启动时间记录缺失。")?;
    let executable = value["executable"]
        .as_str()
        .ok_or("CS2 程序路径记录缺失。")?;
    let mut candidates = Vec::new();
    let mut observations = Vec::new();
    for pid in cs2_pids(log)? {
        if let Some(process) = open(pid, log)? {
            match unsafe { WaitForSingleObject(process.0, 0) } {
                0 => continue,
                258 => (),
                _ => {
                    return Err(win32_failure(
                        log,
                        "WaitForSingleObject",
                        "无法确认 CS2 是否运行，备份仍保留。",
                    ))
                }
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

struct CloseRequest {
    pid: u32,
    windows: u32,
    error: Option<(&'static str, u32)>,
}

unsafe extern "system" fn close_window(window: isize, data: isize) -> i32 {
    let request = &mut *(data as *mut CloseRequest);
    let mut found = 0;
    GetWindowThreadProcessId(window, &mut found);
    if found == request.pid {
        request.windows += 1;
        if PostMessageW(window, 0x0010, 0, 0) == 0 {
            // Capture on the failing thread before enumeration or waiting can
            // overwrite it. Do not send further requests after a refusal.
            request.error = Some(("PostMessageW", GetLastError()));
            return 0;
        }
    }
    1
}

/// Called only with the held, identity-verified process from owned_process.
fn close_owned_process(
    process: &Process,
    pid: u32,
    created: u64,
    log: &crate::startup_log::DesktopLog,
) -> Result<(), String> {
    let mut request = CloseRequest {
        pid,
        windows: 0,
        error: None,
    };
    if unsafe { EnumWindows(close_window, &mut request as *mut CloseRequest as isize) } == 0
        && request.error.is_none()
    {
        request.error = Some(("EnumWindows", unsafe { GetLastError() }));
    }
    // A game that exited during enumeration no longer needs a close request.
    // Failures and absent windows get an immediate stop check, not a 15s wait.
    let wait_ms = if request.error.is_some() || request.windows == 0 {
        0
    } else {
        15000
    };
    let waited = unsafe { WaitForSingleObject(process.0, wait_ms) };
    if waited == 0 {
        return Ok(());
    }
    let message = if let Some((api, code)) = request.error {
        log.event("production_finish", "failure", Some(&format!(
            "phase=game_close_request; api={api}; code={code}; pid={pid}; created={created}; windows={}; cause={}", request.windows, std::io::Error::from_raw_os_error(code as i32)
        )));
        if api == "PostMessageW" && code == 5 {
            "Windows 拒绝向本次 CS2 发送正常关闭请求（PostMessageW，错误 5）。请在游戏内正常退出，再重试退出或恢复配置；备份仍保留。".into()
        } else {
            format!("本次 CS2 的正常关闭请求失败（{api}，Windows 错误 {code}）。请在游戏内正常退出，再重试退出或恢复配置；备份仍保留。")
        }
    } else if waited == 258 {
        let phase = if request.windows == 0 {
            "game_close_no_window"
        } else {
            "game_close_timeout"
        };
        log.event("production_finish", "failure", Some(&format!(
            "phase={phase}; api=WaitForSingleObject; waitResult={waited}; pid={pid}; created={created}; windows={}", request.windows
        )));
        if request.windows == 0 {
            "本次 CS2 仍在运行，但未找到可发送正常关闭请求的窗口。请在游戏内正常退出，再重试退出或恢复配置；备份仍保留。".into()
        } else {
            "已向本次 CS2 发送正常关闭请求，但 15 秒内尚未退出。请在游戏内正常退出，再重试退出或恢复配置；备份仍保留。".into()
        }
    } else {
        let code = unsafe { GetLastError() };
        log.event("production_finish", "failure", Some(&format!(
            "phase=game_close_wait; api=WaitForSingleObject; code={code}; waitResult={waited}; pid={pid}; created={created}; cause={}", std::io::Error::from_raw_os_error(code as i32)
        )));
        format!("无法确认本次 CS2 是否已退出（WaitForSingleObject，Windows 错误 {code}）。请确认游戏正常退出后重试退出或恢复配置；备份仍保留。")
    };
    Err(message)
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
        if self.requires_service {
            return Err("Demo 试播隔离状态需要制播服务确认；本次未恢复配置。请修复制播服务启动问题后，在准备中心恢复。".into());
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
    can_preserve: bool,
}

/// A verified session process held open during window operations. Keeping the
/// handle prevents PID reuse from turning a stale window into another game.
pub struct WorkspaceProcess {
    process: Process,
    pub pid: u32,
    pub created: u64,
}
impl WorkspaceProcess {
    pub fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) == 258 }
    }
}
impl ManagedCs2 {
    pub fn new(log: crate::startup_log::DesktopLog) -> Self {
        Self {
            store: SessionStore::new(log.state_root.clone()),
            log,
            message: None,
            launch_observation: None,
            can_preserve: false,
        }
    }
    /// Never poll/recover here: merely showing a startup error must not write files.
    pub fn startup_recovery_status(&self) -> Result<StartupRecoveryStatus, String> {
        let journal = self.store.load()?;
        let requires_service = crate::demo_test::requires_recovery(&self.log, journal.as_ref());
        Ok(StartupRecoveryStatus {
            pending: journal.is_some()
                || self.store.spectator_pending()
                || self.store.playback_cleanup_pending()
                || requires_service,
            running: any_cs2_running(&self.log)?,
            uncertain: journal
                .as_ref()
                .is_some_and(crate::cs2_session::unconfirmed_launch),
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

    pub fn workspace_process(&self) -> Result<Option<WorkspaceProcess>, String> {
        let Some(value) = self.store.load()? else {
            return Ok(None);
        };
        let Some(process) = owned_process(&value, &self.log)? else {
            return Ok(None);
        };
        Ok(Some(WorkspaceProcess {
            process,
            pid: value["pid"].as_u64().ok_or("CS2 进程记录缺失。")? as u32,
            created: value["created"].as_u64().ok_or("CS2 进程记录缺失。")?,
        }))
    }
    pub fn status(&self) -> Result<Value, String> {
        let pending = self.store.load()?;
        let running = pending
            .as_ref()
            .map(|value| owned_process(value, &self.log))
            .transpose()?
            .flatten()
            .is_some();
        let preferences = self.store.preferences()?;
        Ok(
            json!({"qualityPreset": preferences.quality.name(), "frameRateLimit":preferences.frame_rate_limit, "spectatorRecoveryPending": self.store.spectator_pending() && pending.is_none(), "demoCleanupPending": self.store.playback_cleanup_pending() && pending.is_none(), "spectatorWarning":self.store.spectator_warning().or_else(|| pending.as_ref().and_then(|value| value["spectatorWarning"].as_str()).map(str::to_string)), "canPreserve": self.can_preserve && pending.is_none(), "preserveSettings": pending.as_ref().is_some_and(|v| v["preserveSettings"] == true), "pending":pending.is_some(), "running":running, "message":self.message, "busy":false, "phase": if pending.as_ref().is_some_and(crate::cs2_session::unconfirmed_launch) {"uncertain"} else if running {"running"} else if pending.is_some() {"pending"} else {"idle"}}),
        )
    }
    pub fn preferences(
        &mut self,
        preferences: crate::cs2_preferences::Preferences,
    ) -> Result<(), String> {
        self.store.set_preferences(preferences)
    }
    pub fn recover(&mut self, confirm_steam_cancelled: bool) -> Result<(), String> {
        let Some(mut value) = self.store.load()? else {
            return Ok(());
        };
        // A delayed Steam launch remains a transaction until its identity is
        // known, or the operator explicitly cancels Steam's pending request.
        if crate::cs2_session::unconfirmed_launch(&value) {
            let (found, observation) = launched_process(&value, &self.log)?;
            if self.launch_observation.as_ref() != Some(&observation) {
                self.log.event("cs2_launch", "success", Some(&json!({"stage":"observe", "launchTime":value["launchTime"], "expectedExecutable":value["executable"], "processes":observation}).to_string()));
                self.launch_observation = Some(observation);
            }
            if let Some((pid, created)) = found {
                value["pid"] = json!(pid);
                value["created"] = json!(created);
                self.store.save(&value)?;
                self.message = if value["preserveSettings"] == true {
                    Some("已保持原游戏设置；未应用自动画质、帧率和游戏窗口布局，本机 HUD 覆盖已停用。".into())
                } else {
                    None
                };
            } else if !confirm_steam_cancelled {
                self.message = Some("正在等待 Steam 启动 CS2；配置较低或网络较慢时可能需要更久。Mizar 会继续跟踪；如需取消，请先取消 Steam 启动请求，再恢复备份。".into());
                return Ok(());
            }
        }
        if owned_process(&value, &self.log)?.is_some() {
            if confirm_steam_cancelled {
                return Err("CS2 正在运行，请先退出游戏再恢复备份。".into());
            }
            return Ok(());
        }
        let trial = crate::demo_test::quarantine_if_needed(&self.log, Some(&value))?;
        if any_cs2_running(&self.log)? {
            return Err("等待 CS2 退出后恢复原配置。".into());
        }
        // Allow the game to finish saving after its process exits.
        thread::sleep(Duration::from_millis(1500));
        if any_cs2_running(&self.log)? {
            return Err("等待 CS2 退出后恢复原配置。".into());
        }
        if confirm_steam_cancelled && crate::cs2_session::unconfirmed_launch(&value) {
            value["launchCancelled"] = json!(true);
            self.store.save(&value)?;
        }
        // Preserve Demo quarantine until all core cleanup has completed.
        let had_spectator = self.store.spectator_pending();
        let spectator_error = self.store.restore()?;
        if trial.is_some() && any_cs2_running(&self.log)? {
            return Err("游戏配置已恢复，请先退出 CS2 再完成 Demo 试播恢复。".into());
        }
        crate::demo_test::complete(&self.log, trial.as_deref())?;
        if self.store.spectator_pending() {
            self.log.event(
                "cs2_spectator_restore",
                "failure",
                spectator_error
                    .as_deref()
                    .or(self.store.spectator_warning().as_deref()),
            );
            self.message = Some(format!(
                "{} {}",
                if value["preserveSettings"] == true {
                    "本次启动已结束，游戏设置保持不变；观战原值仍待恢复。"
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
            self.message = Some(spectator_error.unwrap_or_else(|| "原设置已恢复。".into()));
        }

        Ok(())
    }
    pub fn poll(&mut self) {
        if let Err(error) = self.recover(false) {
            self.message = Some(error);
        }
    }
    pub fn preserve_settings(&self) -> bool {
        // Corrupt/unreadable journals must also prevent automatic game layout.
        self.store.load().map_or(true, |value| {
            value.is_some_and(|v| v["preserveSettings"] == true)
        })
    }
    pub fn start(&mut self) -> Result<bool, String> {
        self.start_with_settings(false)
    }
    pub fn start_with_settings(&mut self, preserve: bool) -> Result<bool, String> {
        let journal = self.store.load()?;
        if crate::demo_test::requires_recovery(&self.log, journal.as_ref())
            && crate::demo_test::status(&self.log)?["active"] == true
        {
            return Err("请先结束 Demo 试播并恢复游戏配置。".into());
        }
        self.start_internal(preserve, None)
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
        self.start_internal(preserve, Some((&argument, request_id)))
    }
    pub fn demo_launch_attempted(&self) -> Result<bool, String> {
        Ok(self
            .store
            .load()?
            .is_some_and(|v| v["launchAttempted"] == true))
    }
    pub fn has_demo_journal(&self) -> Result<bool, String> {
        Ok(self
            .store
            .load()?
            .is_some_and(|v| v.get("demoTestRequestId").is_some()))
    }
    pub fn validate_demo_running(&mut self, request_id: &str) -> Result<(), String> {
        self.recover(false)?;
        let journal = self.store.load()?.ok_or("Demo 游戏启动记录已失效。")?;
        if journal["demoTestRequestId"].as_str() != Some(request_id)
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
    ) -> Result<bool, String> {
        if preserve && !self.can_preserve {
            return Err("请先检查配置接管结果，再选择保持原游戏设置继续。".into());
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
        let (executable, video, steam) = discover(&self.log)?;
        if any_cs2_running(&self.log)? {
            return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
        }
        self.message = None;
        let size = if preserve {
            None
        } else {
            Some(crate::windows_host::launch_viewport()?)
        };
        let mut journal = if preserve {
            self.store.prepare_preserved(&video, &executable)?
        } else {
            self.can_preserve = false;
            self.store.backup_originals(&video)?;
            match self.store.prepare_backed_up(
                &video,
                &executable,
                size.ok_or("工作台游戏尺寸缺失。")?,
            ) {
                Ok(value) => value,
                Err(error) => {
                    self.can_preserve = self.store.load()?.is_none();
                    self.message = Some(error.clone());
                    // Parser errors contain only fixed categories / known keys.
                    self.log.event(
                        "cs2_launch",
                        "failure",
                        Some(&format!("stage=prepare; {error}")),
                    );
                    return Err(error);
                }
            }
        };
        self.can_preserve = false;
        if journal["spectatorCfg"] == true {
            if let Err(error) = crate::cs2_spectator::install(&executable)
                .and_then(|()| self.store.validate_spectator_launch())
            {
                journal["spectatorCfg"] = json!(false);
                journal["spectatorWarning"] = json!(format!("观战 CFG 未加载：{error}"));
            }
        }
        if !preserve {
            self.log.event(
                "cs2_spectator_cfg",
                if journal["spectatorCfg"] == true {
                    "success"
                } else {
                    "failure"
                },
                Some(
                    &json!({"stage":"prepared", "file":crate::cs2_spectator::CFG_NAME,
                    "runtime":"unverified", "reason":journal["spectatorWarning"]})
                    .to_string(),
                ),
            );
        }
        if let Some((argument, request_id)) = demo {
            journal["demoTestRequestId"] = json!(request_id);
            journal["demoPlaybackCfg"] = crate::demo_test::playback_cfg_plan(request_id, argument)?;
            self.store.save(&journal)?;
            if let Err((error, created)) = crate::demo_test::install_playback_cfg(&journal) {
                // A create_new collision never grants ownership of an existing file.
                // Keep core configuration recovery available after a refused install.
                if !created {
                    if let Some(object) = journal.as_object_mut() {
                        object.remove("demoPlaybackCfg");
                    }
                } else {
                    journal["demoPlaybackCfgError"] = json!(error);
                }
                self.store.save(&journal)?;
                return Err(error);
            }
        }
        self.store.save(&journal)?;
        let launch: Result<bool, String> = (|| {
            // Recheck the same process and current account before committing a
            // request. A refused check remains an unlaunched, recoverable journal.
            steam.validate(&self.log)?;
            if any_cs2_running(&self.log)? {
                return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
            }
            let mut command = Command::new(&steam.process.executable);
            command.current_dir(
                steam
                    .process
                    .executable
                    .parent()
                    .ok_or("Steam 程序目录无效。")?,
            );
            if let Some(size) = size {
                command.args(LAUNCH_ARGS).args([
                    "-w",
                    &size.width.to_string(),
                    "-h",
                    &size.height.to_string(),
                    "+fps_max",
                    &journal["frameRateLimit"]
                        .as_u64()
                        .ok_or("帧率启动参数缺失。")?
                        .to_string(),
                ]);
                if journal["spectatorCfg"] == true {
                    match self.store.spectator_load_attempted(true) {
                        Ok(()) => {
                            command.args(["+exec", crate::cs2_spectator::CFG_NAME]);
                        }
                        Err(error) => {
                            journal["spectatorCfg"] = json!(false);
                            journal["spectatorWarning"] =
                                json!(format!("观战 CFG 未加载：{error}"));
                            self.log.event("cs2_spectator_cfg", "failure", Some(&json!({"stage":"prepared", "file":crate::cs2_spectator::CFG_NAME, "runtime":"unverified", "reason":journal["spectatorWarning"]}).to_string()));
                        }
                    }
                }
            } else {
                command.args(["-applaunch", "730"]);
            }
            if demo.is_some() {
                command.args([
                    "+exec",
                    journal["demoPlaybackCfg"]["name"]
                        .as_str()
                        .ok_or("Demo 播放 CFG 名称缺失。")?,
                ]);
            }
            // Commit the ambiguous-launch marker only after all checks and
            // argument validation, immediately before sending the Steam request.
            let mut time = FileTime::default();
            unsafe {
                GetSystemTimeAsFileTime(&mut time);
            }
            let launch_time = ((time.high as u64) << 32) | time.low as u64;
            journal["launchTime"] = json!(launch_time);
            journal["launchAttempted"] = json!(true);
            self.store.save(&journal)?;
            command
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| {
                    self.log.event("cs2_launch", "failure", Some(&format!("stage=steam_spawn; launchTime={launch_time}; code={:?}; cause={error:?}", error.raw_os_error())));
                    journal["launchAttempted"] = json!(false);
                    if journal["spectatorCfg"] == true {
                        if let Err(error) = self.store.spectator_load_attempted(false) {
                            self.log.event("cs2_spectator_restore", "failure", Some(&error));
                        }
                    }
                    if let Err(save_error) = self.store.save(&journal) {
                        self.log.event("cs2_launch", "failure", Some(&format!("stage=journal_after_spawn_failure; cause={save_error}")));
                    }
                    "CS2 未能启动。"
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
    pub fn restore_backup(&mut self, confirm_steam_cancelled: bool) -> Result<(), String> {
        let result = self.recover(confirm_steam_cancelled).and_then(|_| {
            if self.store.load()?.is_none() && self.store.spectator_pending() {
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
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
            if self.store.load()?.is_none() && self.store.playback_cleanup_pending() {
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再清理试播文件。".into());
                }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再清理试播文件。".into());
                }
                self.store.restore_playback_cleanup().map_err(|error| {
                    self.log
                        .event("demo_playback_cleanup", "failure", Some(&error));
                    error
                })?;
                self.message = Some("原设置已恢复，试播文件已清理。".into());
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
        let journal = self.store.load()?;
        let trial = crate::demo_test::quarantine_if_needed(&self.log, journal.as_ref())?;
        // Poll once to adopt a uniquely identified late launch before closing it.
        self.poll();
        if let Some(value) = self.store.load()? {
            if let Some(process) = owned_process(&value, &self.log)? {
                let pid = value["pid"]
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or("CS2 进程记录缺失。")?;
                let created = value["created"].as_u64().ok_or("CS2 进程记录缺失。")?;
                if let Err(error) = close_owned_process(&process, pid, created, &self.log) {
                    self.message = Some(error.clone());
                    return Err(error);
                }
            }
        }
        if self
            .store
            .load()?
            .as_ref()
            .is_some_and(crate::cs2_session::unconfirmed_launch)
        {
            return Err(
                "Steam 启动仍在等待。请先取消 Steam 启动请求，并确认 CS2 已关闭，再恢复备份。"
                    .into(),
            );
        }
        match self.recover(false) {
            Ok(()) => {
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

#[cfg(test)]
mod tests {
    use super::*;
    // These tests create or inspect machine-wide CS2 / Steam processes. Hold the same
    // gate so the external-game fixture cannot contaminate recovery evidence.
    static GAME_PROCESSES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test]
    fn absent_journal_cleanup_does_not_prove_an_external_game_stopped() {
        let _processes = GAME_PROCESSES.lock().unwrap();
        let root = std::env::temp_dir().join(format!("mizar-external-game-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        // Use a harmless waiting Windows command process with the game's executable
        // name to exercise real process enumeration without CS2 or Steam.
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let executable = root.join("cs2.exe");
        std::fs::copy(system.join("System32/cmd.exe"), &executable).unwrap();
        struct ExternalGame {
            child: std::process::Child,
            root: PathBuf,
        }
        impl Drop for ExternalGame {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
        let mut external = ExternalGame {
            child: Command::new(executable)
                .args(["/D", "/Q", "/K"])
                .creation_flags(0x08000000)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
            root,
        };
        let mut managed = ManagedCs2::new(log);
        assert!(external.child.try_wait().unwrap().is_none());
        assert!(managed.startup_recovery_status().unwrap().running);
        assert!(managed
            .restore_at_startup(true)
            .unwrap_err()
            .contains("CS2 正在运行"));
        assert!(external.child.try_wait().unwrap().is_none());
        managed.finish().unwrap();
        let mut tracker = crate::windows_host::GameTracker::default();
        tracker.alignment_failure = Some(crate::windows_host::AlignmentFailure { stage: "position", api: Some("SetWindowPos"), last_error: Some(5) });
        tracker.group_failure = Some(crate::workspace_group::Failure { stage: "raise", api: "SetWindowPos", last_error: Some(5), target: "game" });
        assert!(!tracker.finish_session_feedback(&managed).unwrap());
        assert!(tracker.window_message().is_some());
        assert!(managed.confirm_game_stopped().is_err());
        // An unrelated process must never be closed by the cleanup operation.
        assert!(external.child.try_wait().unwrap().is_none());
        external.child.kill().unwrap();
        external.child.wait().unwrap();
        managed.confirm_game_stopped().unwrap();
        assert!(tracker.finish_session_feedback(&managed).unwrap());
        assert_eq!(tracker.window_message(), None);
        assert!(!tracker.managed);
    }

    #[test]
    fn startup_restore_retains_pending_until_cancelled_and_never_bypasses_demo_isolation() {
        let _processes = GAME_PROCESSES.lock().unwrap();
        let root =
            std::env::temp_dir().join(format!("mizar-startup-recovery-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let mut managed = ManagedCs2::new(log.clone());
        let video = root.join("cs2_video.txt");
        std::fs::write(&video, b"original untouched settings").unwrap();
        let mut journal = managed
            .store
            .prepare_preserved(&video, &root.join("absent/cs2.exe"))
            .unwrap();
        journal["launchAttempted"] = json!(true);
        journal["launchTime"] = json!(1); // Complete the same submitted-launch record as the existing owner fixture.
        managed.store.save(&journal).unwrap();
        let before = std::fs::read(managed.store.backup_directory().join("pending.json")).unwrap();
        assert!(managed.startup_recovery_status().unwrap().uncertain);
        assert!(managed
            .restore_at_startup(false)
            .unwrap_err()
            .contains("Steam"));
        assert_eq!(
            std::fs::read(managed.store.backup_directory().join("pending.json")).unwrap(),
            before
        );
        managed.restore_at_startup(true).unwrap();
        assert!(managed.store.load().unwrap().is_none());
        assert_eq!(
            std::fs::read(&video).unwrap(),
            b"original untouched settings"
        );
        // A malformed cleanup handoff preserves the core journal as a soft warning.
        // The offline entry must return that real cause, rather than announce success.
        let mut warning_journal = managed
            .store
            .prepare_preserved(&video, &root.join("absent/cs2.exe"))
            .unwrap();
        warning_journal["demoPlaybackCfg"] = json!({});
        managed.store.save(&warning_journal).unwrap();
        let warning = managed.restore_at_startup(false).unwrap().unwrap();
        assert!(warning.contains("清理证据转存失败"));
        assert!(warning.contains("原启动记录仍保留"));
        assert!(managed.startup_recovery_status().unwrap().pending);
        assert_eq!(
            std::fs::read(&video).unwrap(),
            b"original untouched settings"
        );
        warning_journal
            .as_object_mut()
            .unwrap()
            .remove("demoPlaybackCfg");
        managed.store.save(&warning_journal).unwrap();
        let retry = managed.restore_at_startup(false).unwrap().unwrap();
        assert!(!retry.contains("清理证据转存失败"));
        assert!(!managed.startup_recovery_status().unwrap().pending);
        managed
            .store
            .prepare_preserved(&video, &root.join("absent/cs2.exe"))
            .unwrap();
        std::fs::write(
            log.state_root.join("data/demo-test.json"),
            b"corrupt-is-still-an-isolation-hint",
        )
        .unwrap();
        assert!(managed.startup_recovery_status().unwrap().requires_service);
        assert!(managed
            .restore_at_startup(true)
            .unwrap_err()
            .contains("Demo"));
        assert!(managed.store.load().unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn steam_native_identity_survives_missing_module_path_and_rejects_changed_processes() {
        let _processes = GAME_PROCESSES.lock().unwrap();
        let root =
            std::env::temp_dir().join(format!("mizar-steam-identity-{}", std::process::id()));
        // Non-ASCII, spaces and PowerShell metacharacters must stay literal data.
        let directory = root.join("Steam 中文 space $() ' &");
        std::fs::create_dir_all(&directory).unwrap();
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let executable = directory.join("steam.exe");
        std::fs::copy(system.join("System32/cmd.exe"), &executable).unwrap();
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let spawn = || {
            Fixture(
                Command::new(&executable)
                    .args(["/D", "/Q", "/K"])
                    .creation_flags(0x08000000)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        };
        assert!(SteamProcess::discover(&log).is_err());
        let mut first = spawn();
        let mut steam = SteamProcess::discover(&log).unwrap();
        assert_eq!(steam.pid, first.0.id());
        assert!(same_executable(
            &steam.executable,
            &executable.to_string_lossy()
        ));
        // Exercise the real Host -> Windows PowerShell 5.1 handoff. Native
        // enumeration and image queries remain real; only module/account data
        // are controlled, without touching the user's registry or launching CS2.
        let context_script = r#"
function Get-Process {
  param([string]$Name)
  $process = [pscustomobject]@{ Id=$nativeSteam.pid }
  $process | Add-Member -MemberType ScriptProperty -Name Path -Value { throw [IO.IOException]::new('module unavailable') }
  $process
}
function Get-ItemProperty { param([string]$LiteralPath) [pscustomobject]@{ ActiveUser=123 } }
$context = Get-SteamLaunchContext -NativeIdentity $nativeSteam
@{account=$context.account; pathMatches=($context.executable -ceq $nativeSteam.executable)} | ConvertTo-Json -Compress
"#;
        let output = powershell(context_script, &steam, Some(123), &log).unwrap();
        let context: Value = serde_json::from_str(output.trim()).unwrap();
        assert_eq!(context, json!({"account":123,"pathMatches":true}));
        let account_changed = powershell(context_script, &steam, Some(124), &log).unwrap_err();
        let created = steam.created;
        steam.created += 1;
        let process_changed = steam.validate(&log).unwrap_err();
        steam.created = created;
        let video = root.join("cs2_video.txt");
        let original = b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }";
        let mut managed = ManagedCs2::new(log.clone());
        for failure in [&account_changed, &process_changed] {
            std::fs::write(&video, original).unwrap();
            managed
                .store
                .prepare(
                    &video,
                    &root.join("absent/cs2.exe"),
                    crate::cs2_video::VideoSize::new(1920, 1080).unwrap(),
                )
                .unwrap();
            assert_ne!(std::fs::read(&video).unwrap(), original);
            assert!(!managed.demo_launch_attempted().unwrap());
            assert_eq!(
                managed
                    .complete_launch(Err(failure.clone()), false)
                    .unwrap_err(),
                *failure
            );
            assert_eq!(std::fs::read(&video).unwrap(), original);
            assert!(managed.store.load().unwrap().is_none());
        }
        // Preserve mode owns no game writes; failure removes only its journal.
        managed
            .store
            .prepare_preserved(&video, &root.join("absent/cs2.exe"))
            .unwrap();
        let changed = b"operator settings changed while preparing";
        std::fs::write(&video, changed).unwrap();
        assert!(managed
            .complete_launch(Err(account_changed.clone()), false)
            .is_err());
        assert_eq!(std::fs::read(&video).unwrap(), changed);
        assert!(managed.store.load().unwrap().is_none());
        // Demo completion remains with the existing caller: it must cancel the
        // Companion trial before recovery, and may do so only with no request.
        std::fs::write(&video, original).unwrap();
        let mut journal = managed
            .store
            .prepare(
                &video,
                &root.join("absent/cs2.exe"),
                crate::cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        journal["demoTestRequestId"] = json!(crate::demo_test::request_id().unwrap());
        managed.store.save(&journal).unwrap();
        assert!(managed.complete_launch(Err(account_changed), true).is_err());
        assert!(!managed.demo_launch_attempted().unwrap());
        assert!(managed.has_demo_journal().unwrap());
        assert!(!crate::cs2_session::unconfirmed_launch(
            &managed.store.load().unwrap().unwrap()
        ));
        // Caller cancellation is tested in the Companion lifecycle owner. Clean
        // this physical fixture directly without pretending to cancel that RPC.
        managed.store.restore().unwrap();
        assert_eq!(std::fs::read(&video).unwrap(), original);
        let path = steam.executable.clone();
        steam.executable = root.join("different/steam.exe");
        assert!(steam.validate(&log).is_err());
        steam.executable = path;
        let second = spawn();
        assert!(SteamProcess::discover(&log).is_err());
        assert!(steam.validate(&log).is_err());
        drop(second);
        steam.validate(&log).unwrap();
        first.0.kill().unwrap();
        first.0.wait().unwrap();
        assert!(steam.validate(&log).is_err());
        let replacement = spawn();
        // A new process at the same program path must not replace the held one.
        assert!(steam.validate(&log).is_err());
        drop(replacement);
        drop(steam);
        drop(first);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_ownership_requires_pid_creation_time_and_executable() {
        let pid = std::process::id();
        let root = std::env::temp_dir().join(format!("mizar-identity-{}", pid));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let process = open(pid, &log).unwrap().unwrap();
        let (created, path) = identity(&process, &log).unwrap();
        let mut journal = json!({"pid":pid,"created":created,"executable":path});
        assert!(owned_process(&journal, &log).unwrap().is_some());
        journal["created"] = json!(created + 1);
        assert!(owned_process(&journal, &log).unwrap().is_none());
        journal["created"] = json!(created);
        journal["executable"] = json!("C:\\different\\cs2.exe");
        assert!(owned_process(&journal, &log).unwrap().is_none());
        let mut managed = ManagedCs2::new(log);
        let id = crate::demo_test::request_id().unwrap();
        journal["version"] = json!(1);
        journal["executable"] = json!(path);
        journal["demoTestRequestId"] = json!(id);
        managed.store.save(&journal).unwrap();
        // A running, owned process is necessary but insufficient: it must also
        // belong to this exact native Demo launch request.
        assert!(managed.validate_demo_running(&id).is_ok());
        assert!(managed
            .validate_demo_running(&crate::demo_test::request_id().unwrap())
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slow_launch_stays_pending_and_requires_explicit_cancel_before_restoration() {
        let _processes = GAME_PROCESSES.lock().unwrap();
        let root = std::env::temp_dir().join(format!("mizar-waiting-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let mut managed = ManagedCs2::new(log);
        let video = root.join("cs2_video.txt");
        let original = b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }";
        std::fs::write(&video, original).unwrap();
        let mut journal = managed
            .store
            .prepare(
                &video,
                &root.join("absent/cs2.exe"),
                crate::cs2_video::VideoSize::new(1920, 1080).unwrap(),
            )
            .unwrap();
        journal["launchAttempted"] = json!(true);
        journal["launchTime"] = json!(1);
        managed.store.save(&journal).unwrap();
        for _ in 0..3 {
            managed.poll();
        }
        assert_eq!(managed.status().unwrap()["phase"], "uncertain");
        managed.can_preserve = true;
        assert_eq!(managed.status().unwrap()["canPreserve"], false);
        assert!(!managed.start_with_settings(true).unwrap());
        assert!(!managed.preserve_settings());
        assert!(managed.store.load().unwrap().is_some());
        assert!(managed.finish().is_err());
        let mut tracker = crate::windows_host::GameTracker::default();
        tracker.alignment_failure = Some(crate::windows_host::AlignmentFailure { stage: "position", api: Some("SetWindowPos"), last_error: Some(5) });
        assert!(!tracker.finish_session_feedback(&managed).unwrap());
        assert!(tracker.window_message().is_some());
        assert_ne!(std::fs::read(&video).unwrap(), original);
        managed.restore_backup(true).unwrap();
        assert_eq!(std::fs::read(&video).unwrap(), original);
        assert!(managed.store.load().unwrap().is_none());
        assert!(tracker.finish_session_feedback(&managed).unwrap());
        assert_eq!(tracker.window_message(), None);
        // A damaged core record leaves restoration unknown, even with no game.
        tracker.alignment_failure = Some(crate::windows_host::AlignmentFailure { stage: "position", api: Some("SetWindowPos"), last_error: Some(5) });
        std::fs::write(managed.store.backup_directory().join("pending.json"), b"{").unwrap();
        assert!(tracker.finish_session_feedback(&managed).is_err());
        assert!(tracker.window_message().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn equivalent_windows_paths_keep_identity_without_accepting_other_installations() {
        assert!(same_executable(
            std::path::Path::new(r"\\?\C:\Games\CS2\cs2.exe"),
            "c:/games/cs2/cs2.exe"
        ));
        assert!(!same_executable(
            std::path::Path::new(r"C:\Other\cs2.exe"),
            r"C:\Games\cs2.exe"
        ));
    }
}
