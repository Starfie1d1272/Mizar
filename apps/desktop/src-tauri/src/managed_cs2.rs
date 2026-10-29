use crate::cs2_session::SessionStore;
use serde_json::{json, Value};
use std::{
    os::windows::process::CommandExt,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
    sync::Arc,
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
    #[cfg(test)]
    fixture: bool,
}
impl SteamLaunch {
    fn validate(&self, log: &crate::startup_log::DesktopLog) -> Result<(), String> {
        #[cfg(test)]
        if self.fixture { return Ok(()); }
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
            #[cfg(test)]
            fixture: false,
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
    fn GetProcessId(process: Handle) -> u32;
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
pub(crate) fn process_parent(pid: u32, log: &crate::startup_log::DesktopLog) -> Result<Option<u32>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snapshot == -1 { return Err(win32_failure(log, "CreateToolhelp32Snapshot", "无法检查游戏进程，请重试。")); }
    let snapshot = Process(snapshot);
    let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while found != 0 {
        if entry.pid == pid { return Ok(Some(entry.parent)); }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != 18 { return Err(win32_failure(log, "Process32NextW", "无法检查游戏进程，请重试。")); }
    Ok(None)
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
        return Err(identity_failure(
            log,
            process,
            "GetProcessTimes",
            "无法确认进程创建时间。",
            None,
        ));
    }
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err(identity_failure(
            log,
            process,
            "QueryFullProcessImageNameW",
            "无法确认进程程序路径。",
            Some(((created.high as u64) << 32) | created.low as u64),
        ));
    }
    Ok((
        ((created.high as u64) << 32) | created.low as u64,
        PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])),
    ))
}
fn identity_failure(log: &crate::startup_log::DesktopLog, process: &Process, api: &str, message: &str, created: Option<u64>) -> String {
    // Preserve the failing API's error before any diagnostic observation changes it.
    let code = unsafe { GetLastError() };
    let pid = unsafe { GetProcessId(process.0) };
    let waited = unsafe { WaitForSingleObject(process.0, 0) };
    log.event("cs2_launch", "failure", Some(&format!(
        "source=Win32; phase=process_identity; api={api}; code={code}; targetPid={}; targetCreated={created:?}; targetWaitResult={waited}; cause={}",
        if pid == 0 { "unknown".into() } else { pid.to_string() },
        std::io::Error::from_raw_os_error(code as i32)
    )));
    message.into()
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
    selected_backup: Option<Value>,
    external: Option<ExternalSession>,
    camera: Option<CameraLease>,
    mulnx_launcher: Option<Arc<crate::mulnx_launch::HiddenLauncher>>,
    pending_mulnx_stop: Option<(Value, WorkspaceProcess)>,
    // Keep window preservation after detach until a new managed launch is accepted.
    external_preservation: bool,
    #[cfg(test)]
    recovery_identity_fixture: Option<(PathBuf, PathBuf, u32)>,
    #[cfg(test)]
    launch_fixture: Option<LaunchFixture>,
}

#[cfg(test)]
struct LaunchFixture {
    executable: PathBuf,
    video: PathBuf,
    account: u32,
    fail_submit: bool,
    submitted: Arc<std::sync::Mutex<Vec<(Value, Vec<String>)>>>,
}

/// A verified session process held open during window operations. Keeping the
/// handle prevents PID reuse from turning a stale window into another game.
#[derive(Clone)]
pub struct WorkspaceProcess {
    process: Arc<Process>,
    pub owned: bool,
    pub pid: u32,
    pub created: u64,
}
struct CameraLease {
    process: WorkspaceProcess,
    lease: String,
    invalidated: bool,
}
struct ExternalSession {
    console_source: Value,
    demo_request_id: Option<String>,
    invalidated: bool,
    isolation_pending: bool,
    process: Arc<Process>,
    pid: u32,
    created: u64,
}
impl WorkspaceProcess {
    pub fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) == 258 }
    }
    pub(crate) fn has_exited(&self) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            0 => Ok(true), 258 => Ok(false), _ => Err("无法检查游戏状态，请重试。".into()),
        }
    }
}
pub fn verified_session_process(
    value: &Value,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<WorkspaceProcess>, String> {
    let Some(process) = owned_process(value, log)? else {
        return Ok(None);
    };
    Ok(Some(WorkspaceProcess {
        process: Arc::new(process),
        owned: true,
        pid: value["pid"].as_u64().ok_or("CS2 进程记录缺失。")? as u32,
        created: value["created"].as_u64().ok_or("CS2 进程记录缺失。")?,
    }))
}
impl ManagedCs2 {
    pub fn new(log: crate::startup_log::DesktopLog) -> Self {
        Self {
            store: SessionStore::new(log.state_root.clone()),
            log,
            message: None,
            launch_observation: None,
            can_preserve: false,
            selected_backup: None,
            external: None,
            camera: None,
            mulnx_launcher: None,
            pending_mulnx_stop: None,
            external_preservation: false,
            #[cfg(test)]
            recovery_identity_fixture: None,
            #[cfg(test)]
            launch_fixture: None,
        }
    }
    pub(crate) fn pending_mulnx_stop(&self) -> Option<(Value, WorkspaceProcess)> {
        self.pending_mulnx_stop.clone()
    }
    pub(crate) fn remember_mulnx_stop(&mut self, context: Value, game: WorkspaceProcess) {
        self.pending_mulnx_stop = Some((context, game));
    }
    pub(crate) fn clear_mulnx_stop(&mut self) { self.pending_mulnx_stop = None; }
    pub(crate) fn remember_mulnx_launcher(&mut self, launcher: Arc<crate::mulnx_launch::HiddenLauncher>) {
        self.mulnx_launcher = Some(launcher);
    }
    pub(crate) fn owns_mulnx_launcher(&self, pid: u32) -> Result<bool, String> {
        match &self.mulnx_launcher {
            Some(launcher) if launcher.pid() == pid => launcher.running().map_err(|e| e.to_string()),
            _ => Ok(false),
        }
    }
    fn recovery_identity(&self) -> Result<(PathBuf, PathBuf, u32), String> {
        #[cfg(test)]
        if let Some(identity) = &self.recovery_identity_fixture { return Ok(identity.clone()); }
        let (executable, video, steam) = discover(&self.log)?;
        steam.validate(&self.log)?;
        Ok((executable, video, steam.account))
    }
    pub(crate) fn prepare_observer_for_mulnx(&mut self, expected_executable: &Path) -> Result<bool, String> {
        if self.has_external() || any_cs2_running(&self.log)? { return Err("请先退出 CS2 再启动观战配置。".into()); }
        crate::observer_hud::restore(&self.log)?;
        let (executable, video, steam) = discover(&self.log)?;
        steam.validate(&self.log)?;
        if !same_executable(&executable, &expected_executable.to_string_lossy()) { return Err("游戏安装位置已变化，未加载观战配置。".into()); }
        if any_cs2_running(&self.log)? { return Err("请先退出 CS2 再启动观战配置。".into()); }
        self.store.prepare_mulnx_observer(&video, &executable, steam.account)
    }
    pub(crate) fn validate_prepared_mulnx_observer(&self, expected_executable: &Path) -> Result<(), String> {
        if self.has_external() || any_cs2_running(&self.log)? { return Err("请先退出 CS2，再启动观战配置。".into()); }
        let (executable, video, account) = self.recovery_identity()?;
        if !same_executable(&executable, &expected_executable.to_string_lossy()) { return Err("游戏安装位置已变化。".into()); }
        self.store.validate_unsubmitted_mulnx_observer(&video, &executable, account)
    }
    pub(crate) fn mark_observer_mulnx_options_clean(&self) -> Result<(), String> {
        self.store.mark_mulnx_options_clean()
    }
    pub(crate) fn cancel_unsubmitted_mulnx_observer(&mut self) -> Result<(), String> {
        if self.has_external() || any_cs2_running(&self.log)? || !process_pids("CS2Injector.exe", &self.log)?.is_empty() {
            return Err("请先退出 CS2 和 MulNX 启动器，再恢复观战备份。".into());
        }
        self.store.cancel_unsubmitted_mulnx_observer()
    }
    pub(crate) fn prepared_native_hud(&self) -> Result<bool, String> {
        Ok(self.store.spectator_hud_identity()?.is_some())
    }
    pub(crate) fn mulnx_observer_receipt_matches(&self, pid: u32, created: u64, executable: &Path) -> Result<bool, String> {
        if self.store.full_spectator_pending() || self.store.load()?.is_some() { return Ok(false); }
        Ok(self.store.mulnx_observer_matches(pid, created, executable)?.is_some())
    }
    pub(crate) fn bind_observer_mulnx_process(&self, pid: u32, created: u64, executable: &Path) -> Result<(), String> {
        if cs2_pids(&self.log)? != vec![pid] { return Err("游戏实例不唯一，观战备份仍保留。".into()); }
        let process = open(pid, &self.log)?.ok_or("游戏已退出，观战备份仍保留。")?;
        let (actual_created, actual_executable) = identity(&process, &self.log)?;
        if actual_created != created || !same_executable(&actual_executable, &executable.to_string_lossy()) {
            return Err("游戏身份已变化，观战备份仍保留。".into());
        }
        self.store.bind_mulnx_observer(pid, created, executable)
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
            uncertain: journal.as_ref().is_some_and(crate::cs2_session::unconfirmed_launch)
                || self.store.mulnx_observer_unconfirmed()?
                || (journal.is_some() && self.log.state_root.join("data/mulnx-launch/pending.json").exists()),
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

    pub fn has_external(&self) -> bool { self.external.is_some() }
    pub(crate) fn external_matches(&self, game: &WorkspaceProcess) -> bool {
        self.external.as_ref().is_some_and(|external|
            external.pid == game.pid && external.created == game.created && Arc::ptr_eq(&external.process, &game.process))
    }
    pub fn attach_external(&mut self, pid: u32, created: u64, executable: &std::path::Path) -> Result<(), String> {
        let observer = self.store.mulnx_observer_matches(pid, created, executable)?;
        if self.store.load()?.is_some() || self.store.full_spectator_pending() || (self.store.spectator_pending() && observer.is_none())
            || self.store.playback_cleanup_pending()
            || crate::demo_test::requires_recovery(&self.log, None)
        { return Err("请先完成 Mizar 原有游戏与配置恢复，再使用外部游戏。".into()); }
        if let Some(external) = &self.external {
            if !external.invalidated && external.pid == pid && external.created == created
                && unsafe { WaitForSingleObject(external.process.0, 0) } == 258
                && cs2_pids(&self.log)? == vec![pid]
                && identity(&external.process, &self.log)?.1.to_string_lossy().eq_ignore_ascii_case(&executable.to_string_lossy())
            { return Ok(()); }
            return Err("已有借用实例，请先退出工作台解除借用。".into());
        }
        // Refuse ambiguity, stale UI identities, a different installation and exited processes.
        if cs2_pids(&self.log)? != vec![pid] { return Err("CS2 实例不唯一或已变化，请重新检查。".into()); }
        let process = open(pid, &self.log)?.ok_or("所选 CS2 已退出，请重新检查。")?;
        let (actual_created, actual_executable) = identity(&process, &self.log)?;
        if actual_created != created
            || !actual_executable.to_string_lossy().eq_ignore_ascii_case(&executable.to_string_lossy())
            || unsafe { WaitForSingleObject(process.0, 0) } != 258
        { return Err("游戏身份或安装位置不匹配，请重新检查。".into()); }
        let console = crate::cs2_console::boundary(&self.log, &actual_executable)?;
        let console_source = json!({"executable":actual_executable.to_string_lossy(),"launchTime":crate::cs2_console::utc(),"pid":pid,"created":created.to_string(),"consoleDiagnostics":console,"ownership":"external", "nativeHudToggle":observer == Some(true), "spectatorCfg":observer.is_some()});
        self.external = Some(ExternalSession { console_source, demo_request_id: None, invalidated: false, isolation_pending: false, process: Arc::new(process), pid, created });
        self.external_preservation = true;
        self.can_preserve = false;
        self.message = Some("已借用外部游戏；保持原设置和窗口，退出工作台不会关闭它。".into());
        self.log.event("external_game_attach", "success", Some(&json!({"pid":pid,"created":created.to_string(),"ownership":"external","preserveSettings":true}).to_string()));
        Ok(())
    }
    pub fn workspace_process(&self) -> Result<Option<WorkspaceProcess>, String> {
        if let Some(external) = &self.external {
            return Ok((!external.invalidated && unsafe { WaitForSingleObject(external.process.0, 0) } == 258).then(|| WorkspaceProcess {
                process: external.process.clone(), owned: false, pid: external.pid, created: external.created,
            }));
        }
        let Some(value) = self.store.load()? else {
            return Ok(None);
        };
        verified_session_process(&value, &self.log)
    }
    /// Read-only diagnostics context follows the explicit current attachment.
    /// This context is never written to SessionStore and grants no shutdown right.
    pub fn console_source(&self) -> Result<Option<(Value, WorkspaceProcess)>, String> {
        let Some(process) = self.workspace_process()? else { return Ok(None); };
        let context = if let Some(external) = &self.external {
            if cs2_pids(&self.log)? != vec![external.pid] { return Ok(None); }
            external.console_source.clone()
        } else {
            let Some(journal) = self.store.load()? else { return Ok(None); };
            journal
        };
        Ok(Some((context, process)))
    }
    /// Inspection only: do not adopt a process, write a session, restore config or close a game.
    pub(crate) fn mulnx_launcher_running(&self) -> Result<bool, String> {
        Ok(!process_pids("CS2Injector.exe", &self.log)?.is_empty())
    }
    pub fn mulnx_handoff_status(&self) -> Result<Value, String> {
        let owned = if self.has_external() { None } else { self.workspace_process()? };
        let mut processes = Vec::new();
        for pid in cs2_pids(&self.log)? {
            let Some(process) = open(pid, &self.log)? else { continue; };
            let (created, executable) = identity(&process, &self.log)?;
            if unsafe { WaitForSingleObject(process.0, 0) } != 258
                || !executable.file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("cs2.exe"))
            { continue; }
            let managed = owned.as_ref().is_some_and(|p| p.pid == pid && p.created == created && p.is_running());
            processes.push(json!({"pid": pid, "created": created.to_string(), "executable": executable, "managed": managed, "borrowed": self.external.as_ref().is_some_and(|p| p.pid == pid && p.created == created)}));
        }
        // Snapshot of kernel identity only; neither launcher provenance nor MulNX readiness.
        Ok(json!({"processes": processes, "url": "http://127.0.0.1:3000/"}))
    }
    pub fn status(&self) -> Result<Value, String> {
        let pending = self.store.load()?;
        let owned_running = pending
            .as_ref()
            .map(|value| owned_process(value, &self.log))
            .transpose()?
            .flatten()
            .is_some();
        let borrowed = self.external.is_some();
        let running = owned_running || (borrowed && self.workspace_process()?.is_some());
        let preferences = self.store.preferences()?;
        let borrowed_observer = running && self.external.as_ref().is_some_and(|external| external.console_source["spectatorCfg"] == true);
        let borrowed_hud = self.external.as_ref().is_some_and(|external| external.console_source["nativeHudToggle"] == true);
        let mulnx_uncertain = self.store.mulnx_observer_unconfirmed()?
            || (pending.is_some() && self.log.state_root.join("data/mulnx-launch/pending.json").exists());
        let mulnx_launch_resumable = if pending.as_ref().is_some_and(|v| v["mulnxLaunch"] == true && v["launchAttempted"] == true) {
            std::fs::read(self.log.state_root.join("data/mulnx-launch/pending.json")).ok()
                .filter(|bytes| bytes.len() <= 16 * 1024)
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(|record| record["request"] == "submitted" && record["executable"].as_str().is_some_and(|path|
                    pending.as_ref().and_then(|v| v["executable"].as_str()).is_some_and(|expected| path.eq_ignore_ascii_case(expected))))
                .and_then(|record| record["launcherPid"].as_u64().filter(|pid| *pid > 0).and_then(|pid| u32::try_from(pid).ok()))
                .is_some_and(|pid| self.owns_mulnx_launcher(pid).unwrap_or(false))
        } else { false };
        Ok(
            json!({"qualityPreset": preferences.quality.name(), "preferMulnx":preferences.prefer_mulnx, "frameRateLimit":preferences.frame_rate_limit, "nativeHudToggle": running && (borrowed_hud || pending.as_ref().is_some_and(|v| v["nativeHudToggle"] == true && v["spectatorCfg"] == true)), "spectatorRecoveryPending": (self.store.spectator_pending() || self.store.full_spectator_pending()) && pending.is_none() && !borrowed_observer, "demoCleanupPending": self.store.playback_cleanup_pending() && pending.is_none(), "spectatorWarning":self.store.spectator_warning().or_else(|| pending.as_ref().and_then(|value| value["spectatorWarning"].as_str()).map(str::to_string)), "canPreserve": self.can_preserve && pending.is_none(), "preserveSettings": borrowed || pending.as_ref().is_some_and(|v| v["preserveSettings"] == true), "pending":pending.is_some(), "mulnxLaunchResumable":mulnx_launch_resumable, "borrowed":borrowed, "externalDetached":self.external_preservation && !borrowed, "running":running, "message":self.message, "busy":false, "phase": if mulnx_uncertain || pending.as_ref().is_some_and(crate::cs2_session::unconfirmed_launch) {"uncertain"} else if running {"running"} else if pending.is_some() {"pending"} else {"idle"}}),
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
        // MulNX requires its gateway check before a process can be adopted.
        // A submitted or interrupted launch remains pending until that check or
        // explicit cancellation after the launcher and game have stopped.
        if self.log.state_root.join("data/mulnx-launch/pending.json").exists() {
            if !confirm_steam_cancelled { return Ok(()); }
            if any_cs2_running(&self.log)? || self.mulnx_launcher_running()? {
                return Err("请先关闭 CS2 和 MulNX 启动器，再恢复配置。".into());
            }
            let executable = value["executable"].as_str().ok_or("游戏路径记录缺失。")?;
            crate::production_exit::prepare_mulnx(&self.log, Path::new(executable), false, false)?;
            std::fs::remove_file(self.log.state_root.join("data/mulnx-launch/pending.json"))
                .map_err(|_| "MulNX 启动记录无法清理，原备份仍保留。")?;
        }
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
        if value["version"] == 4 {
            let (_, video, steam) = discover(&self.log)?;
            if value["video"] != json!(std::fs::canonicalize(&video).map_err(|e| crate::cs2_session::io_error("恢复目标无法确认。", &e))?) { return Err("请登录原目标 Steam 账号后重试恢复。".into()); }
            steam.validate(&self.log)?;
        }
        // Preserve Demo quarantine until all core cleanup has completed.
        let had_spectator = self.store.spectator_pending() || self.store.full_spectator_pending();
        let spectator_error = if value["fullSnapshot"] == true {
            let (executable, video, account) = self.recovery_identity()?;
            if any_cs2_running(&self.log)? { return Err("等待 CS2 退出后恢复原配置。".into()); }
            self.store.restore_coordinated(&video, &executable, account)?
        } else {
            self.store.restore()?
        };
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
            self.message = Some(spectator_error.unwrap_or_else(|| "本地原设置已恢复。".into()));
        }

        Ok(())
    }
    pub fn poll(&mut self) {
        if let Some(external) = &mut self.external {
            if !external.invalidated && (unsafe { WaitForSingleObject(external.process.0, 0) } != 258
                || cs2_pids(&self.log).map_or(true, |pids| pids != vec![external.pid])) {
                external.invalidated = true;
                external.isolation_pending = true;
                self.message = Some("借用实例已退出或不再唯一；自动运镜连接正在隔离，请结束制作后重新检查。".into());
                self.log.event("external_game_invalidated", "unknown", Some(&json!({"pid":external.pid,"created":external.created.to_string()}).to_string()));
            }
            return;
        }
        if let Err(error) = self.recover(false) {
            self.message = Some(error);
        }
    }
    /// A lease is bound to the held, verified game process, never just a PID.
    pub fn bind_managed_camera(&mut self, process: WorkspaceProcess, lease: String) -> Result<(), String> {
        if !process.owned || !process.is_running() || cs2_pids(&self.log)? != vec![process.pid] {
            return Err("受管游戏身份已变化，运镜会话未绑定。".into());
        }
        self.camera = Some(CameraLease { process, lease, invalidated: false });
        Ok(())
    }
    pub fn managed_camera_lease(&mut self) -> Option<(String, bool)> {
        let camera = self.camera.as_mut()?;
        if !camera.process.owned { return None; }
        if !camera.process.is_running() || cs2_pids(&self.log).map_or(true, |pids| pids != vec![camera.process.pid]) {
            camera.invalidated = true;
        }
        Some((camera.lease.clone(), camera.invalidated))
    }
    pub fn invalidate_managed_camera(&mut self) {
        if let Some(camera) = &mut self.camera { if camera.process.owned { camera.invalidated = true; } }
    }
    pub fn clear_managed_camera(&mut self) {
        if self.camera.as_ref().is_some_and(|camera| camera.process.owned) { self.camera = None; }
    }
    pub fn bind_external_camera(&mut self, lease: String) {
        if let Some(external) = &self.external {
            let process = WorkspaceProcess { process: external.process.clone(), owned: false,
                pid: external.pid, created: external.created };
            self.camera = Some(CameraLease { process, lease, invalidated: false });
        }
    }
    pub fn bind_external_demo(&mut self, request_id: String) {
        if let Some(external) = &mut self.external { external.demo_request_id = Some(request_id); }
    }
    pub fn external_camera_lease(&self) -> Option<&str> {
        self.external.as_ref().filter(|external| !external.invalidated || external.isolation_pending)?;
        self.camera.as_ref().filter(|camera| !camera.process.owned).map(|camera| camera.lease.as_str())
    }
    pub fn invalidate_external(&mut self) {
        if let Some(external) = &mut self.external {
            external.invalidated = true;
            external.isolation_pending = true;
        }
        self.message = Some("原生运镜会话已失效；请结束制作后重新借用。".into());
    }
    pub fn external_isolation_pending(&self) -> bool {
        self.external.as_ref().is_some_and(|p| p.isolation_pending)
    }
    pub fn external_isolated(&mut self) {
        if let Some(external) = &mut self.external { external.isolation_pending = false; }
        self.message = Some("借用实例已失效，旧运镜连接已断开；请结束制作后重新检查。".into());
    }
    pub fn preserve_settings(&self) -> bool {
        if self.external_preservation { return true; }
        // Corrupt/unreadable journals must also prevent automatic game layout.
        self.store.load().map_or(true, |value| {
            value.is_some_and(|v| v["preserveSettings"] == true)
        })
    }
    pub fn start(&mut self) -> Result<bool, String> {
        self.start_with_settings(false)
    }
    pub fn start_with_settings(&mut self, preserve: bool) -> Result<bool, String> {
        if self.has_external() {
            self.poll();
            if self.workspace_process()?.is_none() { return Err("借用实例已失效，请先结束本次制作，再重新选择实例。".into()); }
            return Ok(false);
        }
        let journal = self.store.load()?;
        if crate::demo_test::requires_recovery(&self.log, journal.as_ref())
            && crate::demo_test::status(&self.log)?["active"] == true
        {
            return Err("请先结束 Demo 试播并恢复游戏配置。".into());
        }
        self.start_internal(preserve, None, false)
    }
    /// Prepare the same configuration transaction as Steam without submitting a launch.
    pub(crate) fn prepare_managed_mulnx(&mut self, expected: &Path, preserve: bool) -> Result<Value, String> {
        if !self.start_internal(preserve, None, true)? { return Err("请先结束现有游戏并恢复配置。".into()); }
        let journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        if !same_executable(expected, journal["executable"].as_str().ok_or("游戏路径缺失。")?) {
            return Err("游戏安装位置已变化，原配置备份仍保留。".into());
        }
        Ok(journal)
    }
    pub(crate) fn submit_managed_mulnx(&self) -> Result<(), String> {
        let mut journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        let (executable, _, _) = self.recovery_identity()?;
        if !same_executable(&executable, journal["executable"].as_str().ok_or("游戏路径缺失。")?)
            || any_cs2_running(&self.log)? { return Err("游戏身份已变化，未提交启动。".into()); }
        if journal["spectatorCfg"] == true {
            self.store.validate_spectator_launch()?;
            self.store.spectator_load_attempted(true)?;
        }
        let mut time = FileTime::default();
        unsafe { GetSystemTimeAsFileTime(&mut time); }
        journal["launchTime"] = json!(((time.high as u64) << 32) | time.low as u64);
        journal["launchAttempted"] = json!(true);
        self.store.save(&journal)
    }
    pub(crate) fn bind_managed_mulnx(&self, pid: u32, created: u64, executable: &Path) -> Result<(), String> {
        let mut journal = self.store.load()?.ok_or("CS2 配置事务缺失。")?;
        if (!journal["pid"].is_null() || !journal["created"].is_null())
            && (journal["pid"].as_u64() != Some(pid as u64) || journal["created"].as_u64() != Some(created)) {
            return Err("游戏已变化，请关闭游戏和 MulNX 后恢复设置。".into());
        }
        if journal["launchAttempted"] != true || created < journal["launchTime"].as_u64().ok_or("无法确认本次启动，请恢复设置。")?
            || cs2_pids(&self.log)? != vec![pid] { return Err("游戏启动身份不唯一。".into()); }
        let process = open(pid, &self.log)?.ok_or("游戏已退出。")?;
        let (actual_created, actual_executable) = identity(&process, &self.log)?;
        if actual_created != created || !same_executable(&actual_executable, &executable.to_string_lossy())
            || !same_executable(executable, journal["executable"].as_str().ok_or("游戏路径缺失。")?) {
            return Err("游戏身份已变化，原配置备份仍保留。".into());
        }
        journal["pid"] = json!(pid);
        journal["created"] = json!(created);
        self.store.save(&journal)
    }
    pub fn ensure_demo_available(&self) -> Result<(), String> {
        if self.has_external() || self.store.load()?.is_some() || any_cs2_running(&self.log)? {
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
        self.start_internal(preserve, Some((&argument, request_id)), false)
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
        if let Some(external) = &self.external {
            if !external.invalidated && external.demo_request_id.as_deref() == Some(request_id)
                && cs2_pids(&self.log)? == vec![external.pid]
                && self.workspace_process()?.is_some_and(|process| process.is_running()) {
                return Ok(());
            }
            return Err("外部 Demo 试播或游戏实例已变化，请重新交接。".into());
        }
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
        prepare_only: bool,
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
        if !preserve {
            // Finish any legacy runtime journal before a new native-toggle session.
            crate::observer_hud::restore(&self.log)?;
        }
        #[cfg(test)]
        let (executable, video, steam) = if let Some(fixture) = &self.launch_fixture {
            let pid = std::process::id();
            let process = open(pid, &self.log)?.ok_or("fixture process unavailable")?;
            (fixture.executable.clone(), fixture.video.clone(), SteamLaunch {
                process: SteamProcess { process, pid, created: 0, executable: fixture.executable.clone() },
                account: fixture.account, fixture: true,
            })
        } else { discover(&self.log)? };
        #[cfg(not(test))]
        let (executable, video, steam) = discover(&self.log)?;
        if any_cs2_running(&self.log)? {
            return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
        }
        self.message = None;
        self.external_preservation = false;
        let size = if preserve {
            None
        } else {
            #[cfg(test)]
            { if self.launch_fixture.is_some() { Some(crate::cs2_video::VideoSize::new(1920, 1080)?) } else { Some(crate::windows_host::launch_viewport()?) } }
            #[cfg(not(test))]
            { Some(crate::windows_host::launch_viewport()?) }
        };
        let mut journal = if preserve {
            self.store.prepare_preserved(&video, &executable)?
        } else {
            self.can_preserve = false;
            self.store.backup_originals(&video)?;
            match self.store.prepare_backed_up(&video, &executable, size.ok_or("工作台游戏尺寸缺失。")?) {
                Ok(value) => value,
                Err(error) => {
                    self.can_preserve = self.store.load()?.is_none();
                    self.message = Some(error.clone());
                    self.log.event("cs2_launch", "failure", Some(&format!("stage=prepare; {error}")));
                    return Err(error);
                }
            }
        };
        self.can_preserve = false;
        if journal["spectatorCfg"] == true {
            if let Err(error) = (|| {
                self.store.validate_spectator_launch()?;
                if journal["nativeHudToggle"] == true {
                    let identity = journal["hudIdentity"].as_str().ok_or("HUD 键身份缺失。")?;
                    if self.store.spectator_hud_identity()?.as_deref() != Some(identity) { return Err("HUD 键身份记录不一致。".into()); }
                    crate::cs2_spectator::install_hud(&executable, identity)
                } else { crate::cs2_spectator::install(&executable) }
            })()
            {
                journal["spectatorCfg"] = json!(false);
                journal["spectatorWarning"] = json!(format!("观战 CFG 未加载：{error}"));
            }
        }
        if !preserve {
            self.log.event(
                "cs2_spectator_cfg",
                if journal["spectatorCfg"] == true || journal["fullSnapshot"] == true {
                    "success"
                } else {
                    "failure"
                },
                Some(
                    &json!({"stage":"prepared", "file":if journal["fullSnapshot"] == true { None } else { Some(crate::cs2_spectator::CFG_NAME) },
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
        match crate::cs2_console::prepare(&self.log, &executable) {
            Ok(Some(prepared)) => journal["consoleDiagnostics"] = prepared,
            Ok(None) => (),
            Err(error) => {
                if error.starts_with("raw_console_preservation_failed:") {
                    self.log.event("cs2_console_prepare", "failure", Some(&json!({"error":error,"condebugRequested":false,"gameLaunchContinues":false}).to_string()));
                    journal["consoleDiagnosticsWarning"] = json!({"code":"raw_preservation_failed","error":error});
                    self.store.save(&journal)?;
                    return Err(format!("上一场原始控制台尚未安全保存，已停止启动 CS2。请归档 console-history 或检查磁盘后重试。{error}"));
                }
                self.log.event("cs2_console_prepare", "failure", Some(&json!({"error":error,"condebugRequested":false,"gameLaunchContinues":true}).to_string()));
                journal["consoleDiagnosticsWarning"] =
                    json!({"code":"source_prepare_failed","error":error});
            }
        }
        if prepare_only { journal["mulnxLaunch"] = json!(true); }
        self.store.save(&journal)?;
        if prepare_only { return Ok(true); }
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
            } else {
                command.args(["-applaunch", "730"]);
            }
            if journal["spectatorCfg"] == true {
                match self.store.spectator_load_attempted(true) {
                    Ok(()) => {
                        let cfg = if journal["nativeHudToggle"] == true {
                            crate::cs2_spectator::hud_cfg_name(journal["hudIdentity"].as_str().unwrap_or(""))?
                        } else { crate::cs2_spectator::CFG_NAME };
                        command.args(["+exec", cfg]);
                    }
                    Err(error) => {
                        journal["spectatorCfg"] = json!(false);
                        journal["spectatorWarning"] =
                            json!(format!("观战 CFG 未加载：{error}"));
                        self.log.event("cs2_spectator_cfg", "failure", Some(&json!({"stage":"prepared", "file":crate::cs2_spectator::CFG_NAME, "runtime":"unverified", "reason":journal["spectatorWarning"]}).to_string()));
                    }
                }
            }

            if journal["consoleDiagnostics"]["version"] == 1 {
                match crate::cs2_console::settings(&self.log) {
                    Ok(config)
                        if config["enabled"] == true
                            && config["generation"]
                                == journal["consoleDiagnostics"]["generation"] =>
                    {
                        command.arg("-condebug");
                    }
                    result => {
                        self.log.event("cs2_console_prepare", "interrupted", Some(&json!({"reason":"consent_changed_before_launch","current":format!("{result:?}"),"condebugRequested":false}).to_string()));
                        journal["consoleDiagnostics"] = Value::Null;
                    }
                }
            }
            if demo.is_some() {
                command.args([
                    "+exec",
                    journal["demoPlaybackCfg"]["name"]
                        .as_str()
                        .ok_or("Demo 播放 CFG 名称缺失。")?,
                ]);
            }
            self.log.event("cs2_launch_arguments", "begin", Some(&json!({
                "program": command.get_program().to_string_lossy(),
                "arguments": command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect::<Vec<_>>(),
                "preserveSettings": size.is_none(), "runtime":"unverified",
                "argumentsScope":"requested-steam-command",
                "steamInheritedArguments":"unobserved", "actualGameArguments":"unobserved"
            }).to_string()));
            // Recheck the account and saved key identity immediately before submission.
            steam.validate(&self.log)?;
            if any_cs2_running(&self.log)? { return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into()); }
            if journal["spectatorCfg"] == true { self.store.validate_spectator_launch()?; }
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
            self.submit_steam(&mut command)
                .map_err(|error| {
                    self.log.event("cs2_launch", "failure", Some(&format!("stage=steam_spawn; launchTime={launch_time}; code={:?}; cause={error:?}", error.raw_os_error())));
                    if journal["fullSnapshot"] == true { journal["launchCancelled"] = json!(true); }
                    else { journal["launchAttempted"] = json!(false); }
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
    fn submit_steam(&self, command: &mut Command) -> std::io::Result<()> {
        #[cfg(test)]
        if let Some(fixture) = &self.launch_fixture {
            let journal = self.store.load().map_err(std::io::Error::other)?.ok_or_else(|| std::io::Error::other("missing launch journal"))?;
            let args = command.get_args().map(|v| v.to_string_lossy().into_owned()).collect();
            fixture.submitted.lock().map_err(|_| std::io::Error::other("fixture lock"))?.push((journal, args));
            if fixture.fail_submit { return Err(std::io::Error::other("injected Steam request failure")); }
            return Ok(());
        }
        command.creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ())
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
        if self.has_external() || self.store.load()?.is_some() || self.store.spectator_pending()
            || self.store.playback_cleanup_pending()
            || crate::demo_test::requires_recovery(&self.log, None) {
            return Err("请先结束工作台并完成上次配置恢复。".into());
        }
        if any_cs2_running(&self.log)? { return Err("请先退出 CS2，再选择恢复备份。".into()); }
        Ok(())
    }
    pub fn cancel_selected_backup(&mut self) { self.selected_backup = None; }
    pub fn select_backup(&mut self, source: &std::path::Path) -> Result<Value, String> {
        self.selected_backup = None;
        self.require_backup_idle()?;
        let (executable, video, steam) = discover(&self.log)?;
        let source = std::fs::canonicalize(source).map_err(|e| crate::cs2_session::io_error("备份路径无法读取。", &e))?;
        let backup = backup_text(&source, 128*1024)?;
        let original = backup_text(&video, 128*1024)?;
        crate::cs2_video::compatible_restore(&backup, &original)?;
        let account_id = (76561197960265728u64 + u64::from(steam.account)).to_string();
        let steam_root = steam.process.executable.parent().ok_or("Steam 目录不可用。")?;
        let users = backup_text(&steam_root.join("config/loginusers.vdf"), 1024*1024)?;
        let nickname = crate::cs2_frame_rate::field(&users, &["users", &account_id, "PersonaName"])?
            .map(|v| v.value).filter(|v| !v.trim().is_empty()).ok_or("当前 Steam 昵称无法读取，请重新登录 Steam 后再试。")?;
        let avatar = backup_avatar(&steam_root.join(format!("config/avatarcache/{account_id}.png")));
        let mut frame = None;
        // Only a named snapshot offers a sibling convars file. A loose .bak
        // never silently selects an unrelated live convars file beside it.
        if source.file_name().is_some_and(|n| n == "cs2_video.txt") {
            let candidate = source.with_file_name("cs2_machine_convars.vcfg");
            match std::fs::symlink_metadata(&candidate) {
                Ok(_) => {
                    let selected = backup_text(&candidate, 256*1024)?;
                    let before = backup_text(&video.with_file_name("cs2_machine_convars.vcfg"), 256*1024)?;
                    crate::cs2_frame_rate::compatible_restore(&selected, &before)?;
                    frame = Some(json!({"source":candidate,"backup":selected,"original":before}));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(crate::cs2_session::io_error("备份中的帧率文件无法读取。", &e)),
            }
        }
        steam.validate(&self.log)?;
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间不可用。")?.as_nanos().to_string();
        let preview = json!({"selectionId":id,"nickname":nickname,"avatar":avatar,
            "sourceName":source.file_name().map(|n|n.to_string_lossy().to_string()),
            "targetPath":video,"includesFrameRate":frame.is_some()});
        self.selected_backup = Some(json!({"id":id,"source":source,"backup":backup,"original":original,
            "video":video,"executable":executable,"account":steam.account,"frame":frame}));
        Ok(preview)
    }
    pub fn apply_selected_backup(&mut self, id: &str) -> Result<(), String> {
        self.require_backup_idle()?;
        let selection = self.selected_backup.as_ref().ok_or("请先选择备份并核对目标账号。")?;
        if selection["id"] != id { return Err("备份选择已变化，请重新核对。".into()); }
        let (executable,video,steam) = discover(&self.log)?;
        if selection["account"].as_u64() != Some(u64::from(steam.account))
            || selection["video"] != json!(video) || selection["executable"] != json!(executable) {
            return Err("Steam 账号或配置位置已变化，请重新选择备份。".into());
        }
        let backup = selection["backup"].as_str().ok_or("备份内容缺失。")?;
        let original = selection["original"].as_str().ok_or("当前配置记录缺失。")?;
        let source = std::path::Path::new(selection["source"].as_str().ok_or("备份路径缺失。")?);
        if backup_text(source,128*1024)? != backup { return Err("所选备份已变化，请重新选择。".into()); }
        let frame = if selection["frame"].is_object() {
            let v = &selection["frame"];
            let selected = v["backup"].as_str().ok_or("帧率备份缺失。")?;
            if backup_text(std::path::Path::new(v["source"].as_str().ok_or("帧率备份路径缺失。")?),256*1024)? != selected {
                return Err("帧率备份已变化，请重新选择。".into());
            }
            Some((v["original"].as_str().ok_or("原始帧率记录缺失。")?,selected))
        } else { None };
        steam.validate(&self.log)?;
        if any_cs2_running(&self.log)? { return Err("CS2 已启动，请退出游戏后重试。".into()); }
        self.store.import_selected_backup(&video,&executable,backup,original,frame)?;
        self.selected_backup = None;
        self.can_preserve = false;
        self.message = Some("所选设置已恢复，恢复前的原件已保存。".into());
        Ok(())
    }
    pub fn restore_backup(&mut self, confirm_steam_cancelled: bool) -> Result<(), String> {
        if self.has_external() { return Err("请先退出工作台解除借用；不会向外部游戏写回配置。".into()); }
        let result = self.recover(confirm_steam_cancelled).and_then(|_| {
            if self.store.load()?.is_none() && self.store.spectator_pending() {
                if self.store.mulnx_observer_unconfirmed()? {
                    if !confirm_steam_cancelled { return Err("MulNX 启动结果待确认，请先关闭 MulNX 启动器及 CS2，再确认恢复。".into()); }
                    if !process_pids("CS2Injector.exe", &self.log)?.is_empty() { return Err("MulNX 启动器仍在运行，观战备份仍保留。".into()); }
                }
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? {
                    return Err("请先退出 CS2 再恢复观战原值。".into());
                }
                if self.store.mulnx_observer_target()?.is_some() && !process_pids("CS2Injector.exe", &self.log)?.is_empty() {
                    return Err("MulNX 启动器仍在运行，观战备份仍保留。".into());
                }
                if let Some((video, executable, account)) = self.store.mulnx_observer_target()? {
                    let (current_exe, current_video, current_account) = self.recovery_identity()?;
                    let saved_video = fs::canonicalize(&video).map_err(|e| crate::cs2_session::io_error("观战恢复目标无法确认。", &e))?;
                    let live_video = fs::canonicalize(&current_video).map_err(|e| crate::cs2_session::io_error("当前账号目标无法确认。", &e))?;
                    let saved_exe = fs::canonicalize(&executable).map_err(|e| crate::cs2_session::io_error("观战程序无法确认。", &e))?;
                    let live_exe = fs::canonicalize(&current_exe).map_err(|e| crate::cs2_session::io_error("当前程序无法确认。", &e))?;
                    if current_account != account || saved_video != live_video || saved_exe != live_exe {
                        return Err("请登录原 Steam 账号并确认原游戏安装位置后再恢复。".into());
                    }
                    // A crash can leave +exec in MulNX even after a game PID was recorded.
                    // Reconcile the owned launch option before clearing the key backup.
                    crate::production_exit::prepare_mulnx(&self.log, &executable, false, false)
                        .map_err(|e| format!("MulNX 启动参数未能清理，观战备份仍保留：{e}"))?;
                    self.store.mark_mulnx_options_clean()?;
                    if any_cs2_running(&self.log)? || !process_pids("CS2Injector.exe", &self.log)?.is_empty() {
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
                if any_cs2_running(&self.log)? { return Err("请先退出 CS2 再恢复观战原值。".into()); }
                thread::sleep(Duration::from_millis(1500));
                if any_cs2_running(&self.log)? { return Err("请先退出 CS2 再恢复观战原值。".into()); }
                let (executable, video, account) = self.recovery_identity()?;
                if any_cs2_running(&self.log)? { return Err("请先退出 CS2 再恢复观战原值。".into()); }
                if let Some(warning) = self.store.restore_full_pending(&video, &executable, account)? {
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
        if self.external_preservation { return Ok(!self.has_external() && self.store.load()?.is_none()); }
        Ok(self.store.load()?.is_none() && !any_cs2_running(&self.log)?)
    }

    fn detach_external(&mut self) -> bool {
        if let Some(external) = self.external.take() {
            if self.camera.as_ref().is_some_and(|camera| !camera.process.owned) { self.camera = None; }
            self.log.event("external_game_detach", "success", Some(&json!({"pid":external.pid,"created":external.created.to_string(),"gameStopped":false}).to_string()));
            self.message = Some("已解除游戏借用；外部游戏及设置保持不变。".into());
            return true;
        }
        false
    }
    pub fn finish(&mut self) -> Result<(), String> {
        self.finish_with_service_stopped(false)
    }
    /// Only the verified service-stop path can skip the lease expiry wait.
    pub fn finish_with_service_stopped(&mut self, service_stopped: bool) -> Result<(), String> {
        let trial_state = if crate::demo_test::requires_recovery(&self.log, None) {
            crate::demo_test::status(&self.log)?
        } else { Value::Null };
        if trial_state["active"] == true && trial_state["gameOwnership"] == "external" {
            let borrowed_observer = self.external.as_ref().is_some_and(|external| external.console_source["spectatorCfg"] == true);
            if self.store.load()?.is_some() || (self.store.spectator_pending() && !borrowed_observer) || self.store.playback_cleanup_pending() {
                return Err("请先完成受管游戏的配置恢复。".into());
            }
            // The trial owns isolated match data, never the externally launched game.
            // Keep the handle until OBS and formal-context restoration both succeed.
            crate::production_exit::disconnect_camera(&self.log)?;
            let trial = crate::demo_test::quarantine(&self.log)?;
            self.invalidate_external();
            crate::demo_test::complete(&self.log, trial.as_deref())?;
            self.external_preservation = true;
            self.detach_external();
            self.message = Some("试播已结束，游戏保持运行。".into());
            return Ok(());
        }
        if self.detach_external() {
            // No owned journal is ever created. Releasing a query handle cannot terminate a game.
            return Ok(());
        }
        if let Some((lease, _)) = self.managed_camera_lease() {
            // The caller holds the CS2 mutex, so the heartbeat cannot renew while
            // the revoke is attempted or while an unknown outcome expires.
            self.invalidate_managed_camera();
            let outcome = retire_camera_before_cleanup(service_stopped,
                || crate::production_exit::camera_session(&self.log, "invalidate", Some(&lease), None).map(|_| ()),
                || thread::sleep(Duration::from_millis(12100)));
            self.log.event("managed_camera_retire", outcome, None);
            self.clear_managed_camera();
        }
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
                // Every owned-game exit, including application shutdown and a
                // failed workbench entry, must pass the same MulNX unload fence.
                // External sessions have already returned through detach above.
                let result = crate::production_exit::finish_then_restore(
                    || self.log.step("cs2_exit_mulnx_unload", || crate::mulnx_launch::stop_managed_for_exit(self, &self.log)),
                    || close_owned_process(&process, pid, created, &self.log),
                );
                if let Err(error) = result {
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
        if let Some(launcher) = &self.mulnx_launcher {
            stop_owned_launcher(
                self.log.state_root.join("data/mulnx-launch/pending.json").exists(),
                || any_cs2_running(&self.log),
                || launcher.stop().map_err(|error| self.log.preserve_error(
                    "mulnx_launcher_exit", None, &error, "本次 MulNX 启动器未能关闭，请检查后重试。".to_string())),
            )?;
            self.log.event("mulnx_launcher_exit", "success", Some("owned launch handle stopped after game exit"));
            self.mulnx_launcher = None;
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

fn stop_owned_launcher(pending: bool, game_running: impl FnOnce() -> Result<bool, String>,
    stop: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    if pending { return Err("MulNX 启动结果仍待确认，请先检查游戏和启动器。".into()); }
    if game_running()? { return Err("CS2 仍在运行，未关闭本次 MulNX 启动器。".into()); }
    stop()
}

/// A failed request does not prove revocation. With renewals fenced by the
/// caller's mutex, wait for two lease periods: at most one timed-out pulse can
/// still arrive before the current lease expires and extend it once. A verified
/// stopped service has no live lease.
fn retire_camera_before_cleanup(service_stopped: bool, revoke: impl FnOnce() -> Result<(), String>,
    wait_for_expiry: impl FnOnce()) -> &'static str {
    if service_stopped { return "service-stopped"; }
    if revoke().is_ok() { return "revoked"; }
    wait_for_expiry();
    "expired-after-unknown"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_launcher_is_stopped_only_after_confirmed_game_exit() {
        let stopped = std::cell::Cell::new(false);
        let stop = || { stopped.set(true); Ok(()) };
        assert!(stop_owned_launcher(true, || Ok(false), stop).is_err());
        assert!(!stopped.get());
        assert!(stop_owned_launcher(false, || Ok(true), stop).is_err());
        assert!(!stopped.get());
        assert!(stop_owned_launcher(false, || Err("unknown".into()), stop).is_err());
        assert!(!stopped.get());
        stop_owned_launcher(false, || Ok(false), stop).unwrap();
        assert!(stopped.get());
    }
    // These tests create or inspect machine-wide CS2 / Steam processes. Hold the same
    // gate so the external-game fixture cannot contaminate recovery evidence.
    static GAME_PROCESSES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test]
    fn camera_retirement_waits_only_when_revocation_is_unknown() {
        let calls = std::cell::RefCell::new(Vec::new());
        let outcome = retire_camera_before_cleanup(false,
            || { calls.borrow_mut().push("revoke"); Err("service unavailable".into()) },
            || calls.borrow_mut().push("lease-expired"));
        calls.borrow_mut().push("game-cleanup");
        assert_eq!(outcome, "expired-after-unknown");
        assert_eq!(*calls.borrow(), ["revoke", "lease-expired", "game-cleanup"]);
        assert_eq!(retire_camera_before_cleanup(false, || Ok(()), || panic!("unneeded wait")), "revoked");
        assert_eq!(retire_camera_before_cleanup(true, || panic!("service stopped"), || panic!("unneeded wait")), "service-stopped");
    }
    #[test]
    fn standard_start_uses_single_observer_cfg_and_preserves_keys() {
        let _processes = GAME_PROCESSES.lock().unwrap();
        for scenario in ["standard", "spawn_failure", "demo", "mulnx_preserved"] {
            let fail = scenario == "spawn_failure";
            let root = std::env::temp_dir().join(format!("mizar-observer-start-{}-{scenario}", std::process::id()));
            std::fs::create_dir_all(&root).unwrap();
            let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
            let mut host = ManagedCs2::new(log);
            let cfg = root.join("steam/userdata/1/730/local/cfg"); std::fs::create_dir_all(&cfg).unwrap();
            std::fs::create_dir_all(root.join("steam/userdata/1/config")).unwrap();
            let video = cfg.join("cs2_video.txt");
            std::fs::write(&video, b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }").unwrap();
            std::fs::write(cfg.join("cs2_machine_convars.vcfg"), b"\"config\" {\"convars\" {\"fps_max\" \"0\" \"spec_usenumberkeys_nobinds\" \"0\"}}").unwrap();
            let keys = cfg.join("cs2_user_keys_0_slot0.vcfg");
            let original = "\"config\" {\"bindings\" {\"h\" \"custom\"} \"analogbindings\" {}}";
            std::fs::write(&keys, original).unwrap();
            let executable = root.join("game/bin/win64/cs2.exe"); std::fs::create_dir_all(executable.parent().unwrap()).unwrap(); std::fs::write(&executable, b"fixture").unwrap();
            std::fs::create_dir_all(root.join("game/csgo/cfg")).unwrap();
            host.store.set_full_optin(1, true).unwrap(); // Existing preference must not start full takeover.
            let submitted = Arc::new(std::sync::Mutex::new(Vec::new()));
            host.launch_fixture = Some(LaunchFixture { executable:executable.clone(), video:video.clone(), account:1, fail_submit:fail, submitted:submitted.clone() });
            host.recovery_identity_fixture = Some((executable.clone(), video.clone(), 1));
            if scenario == "mulnx_preserved" {
                let before_video = std::fs::read(&video).unwrap();
                let before_convars = std::fs::read(cfg.join("cs2_machine_convars.vcfg")).unwrap();
                assert!(host.prepare_managed_mulnx(&executable, true).is_err());
                assert!(host.store.load().unwrap().is_none());
                host.can_preserve = true;
                let journal = host.prepare_managed_mulnx(&executable, true).unwrap();
                assert_eq!(journal["preserveSettings"], true);
                assert_eq!(journal["mulnxLaunch"], true);
                assert_eq!(std::fs::read(&video).unwrap(), before_video);
                assert_eq!(std::fs::read(cfg.join("cs2_machine_convars.vcfg")).unwrap(), before_convars);
                assert!(submitted.lock().unwrap().is_empty());
                std::fs::remove_dir_all(root).unwrap();
                continue;
            }
            let result = if scenario == "demo" {
                host.start_internal(false, Some(("\"C:/fixture.dem\"", "00000000-0000-4000-8000-000000000001")), false)
            } else { host.start() };
            let requests = submitted.lock().unwrap().clone();
            assert_eq!(requests.len(), 1); let (journal, args) = &requests[0];
            assert_ne!(journal["fullSnapshot"], true); assert_eq!(journal["nativeHudToggle"], true);
            let observer_pos = args.windows(2).position(|pair| pair == ["+exec", crate::cs2_spectator::CFG_NAME]).unwrap();
            if scenario == "demo" {
                let demo_name = journal["demoPlaybackCfg"]["name"].as_str().unwrap();
                let demo_pos = args.windows(2).position(|pair| pair[0] == "+exec" && pair[1] == demo_name).unwrap();
                assert!(observer_pos < demo_pos); // Request order; game execution is verified separately.
            }
            assert!(!host.store.full_spectator_pending());
            if fail { assert!(result.is_err()); } else { assert_eq!(result.unwrap(), true); if scenario != "demo" { host.recover(true).unwrap(); } }
            assert_eq!(std::fs::read_to_string(&keys).unwrap(), original);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn coordinated_faults_recover_through_actual_host_entrypoint() {
        use crate::cs2_config_identity::{ConfigIdentity, SessionIdentity};
        use crate::spectator_recovery_plan::{Input, InputKind};
        use std::path::Path;
        use std::sync::atomic::{AtomicUsize, Ordering};
        static FAIL_AT: AtomicUsize = AtomicUsize::new(0);
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        static MODE: AtomicUsize = AtomicUsize::new(0);
        fn injected(path: &Path, bytes: &[u8]) -> Result<(), String> {
            let index = COUNT.fetch_add(1, Ordering::SeqCst) + 1;
            if FAIL_AT.load(Ordering::SeqCst) == index {
                match MODE.load(Ordering::SeqCst) {
                    0 => return Err("injected_before".into()),
                    2 => {
                        if std::fs::read(path).ok().as_deref() == Some(bytes) { return Err("injected_readback".into()); }
                        return Ok(());
                    }
                    _ => (),
                }
            }
            crate::cs2_session::atomic_write(path, bytes)?;
            if FAIL_AT.load(Ordering::SeqCst) == index && MODE.load(Ordering::SeqCst) == 1 { return Err("injected_after".into()); }
            Ok(())
        }
        let _processes = GAME_PROCESSES.lock().unwrap();
        let mut total = 1;
        let mut unwritten_cases = [0usize; 3];
        for mode in 0..=2 {
            let mut target = if mode == 0 { 0 } else { 1 };
            while target <= total {
                let root = std::env::temp_dir().join(format!("mizar-host-fault-{}-{mode}-{target}", std::process::id()));
                let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
                let mut host = ManagedCs2::new(log);
                let cfg = root.join("steam/userdata/1/730/local/cfg"); std::fs::create_dir_all(&cfg).unwrap();
                let video = cfg.join("cs2_video.txt");
                let original_video = b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }";
                std::fs::write(&video, original_video).unwrap();
                let keys = cfg.join("cs2_user_keys_0_slot0.vcfg");
                let original = "\"config\" {\"bindings\" {\"x\" \"personal\"} \"analogbindings\" {}}";
                let candidate = "\"config\" {\"bindings\" {\"x\" \"preset\"} \"analogbindings\" {}}";
                std::fs::write(&keys, original).unwrap();
                let executable = root.join("game/bin/win64/cs2.exe"); std::fs::create_dir_all(executable.parent().unwrap()).unwrap(); std::fs::write(&executable, b"fixture").unwrap();
                let session = SessionIdentity { session_id:format!("fault-{mode}-{target}"), config:ConfigIdentity {
                    account:1, video:std::fs::canonicalize(&video).unwrap(), executable:std::fs::canonicalize(&executable).unwrap(),
                    keys:std::fs::canonicalize(&keys).unwrap(), slot:0, format:"vcfg".into() }};
                let x = Input { kind:InputKind::Key, name:"x".into() };
                FAIL_AT.store(target, Ordering::SeqCst); COUNT.store(0, Ordering::SeqCst); MODE.store(mode, Ordering::SeqCst);
                let result = host.store.prepare_coordinated_with_writer(&video, &executable,
                    crate::cs2_video::VideoSize::new(1920,1080).unwrap(), None, &session,
                    &[x.clone()].into(), &[(x, vec!["preset".into()])].into(), candidate, injected);
                if target == 0 { result.unwrap(); total = COUNT.load(Ordering::SeqCst); assert!(total >= 6); }
                else { assert!(result.is_err(), "failure point {target}, mode {mode}"); }
                FAIL_AT.store(0, Ordering::SeqCst);
                host.recovery_identity_fixture = Some((executable.clone(), video.clone(), 1));
                // If only a provably unwritten snapshot remains, a later user edit
                // must survive the real startup recovery path.
                let orphan = host.store.load().unwrap().is_none() && host.store.full_spectator_pending();
                if orphan { std::fs::write(&keys, "\"config\" {\"bindings\" {\"x\" \"external\"} \"analogbindings\" {}}").unwrap(); }
                let core = host.store.load().unwrap();
                let snapshot: Option<Value> = std::fs::read(host.store.backup_directory().join("spectator-full-pending.json")).ok()
                    .map(|bytes| serde_json::from_slice(&bytes).unwrap());
                let unwritten = core.as_ref().is_some_and(|c| c["configWriteAttempted"] == false && c["launchAttempted"] == false)
                    && snapshot.as_ref().is_some_and(|s| s["payload"]["coordinatedWriteAttempted"] == false);
                let manual_key = if mode == 1 { candidate } else { "\"config\" {\"bindings\" {\"x\" \"external\"} \"analogbindings\" {}}" };
                let manual_video = core.as_ref().and_then(|c| c["applied"].as_str()).map(str::to_owned);
                if unwritten {
                    unwritten_cases[mode] += 1;
                    std::fs::write(&keys, manual_key).unwrap();
                    std::fs::write(&video, manual_video.as_ref().unwrap()).unwrap();
                }
                if host.startup_recovery_status().unwrap().pending { host.restore_at_startup(false).unwrap(); }
                assert!(!host.startup_recovery_status().unwrap().pending);
                assert_eq!(std::fs::read(&video).unwrap(), if unwritten { manual_video.unwrap().into_bytes() } else { original_video.to_vec() });
                let current = std::fs::read_to_string(&keys).unwrap();
                if unwritten { assert_eq!(current, manual_key); }
                else { assert!(current.contains(if orphan { "\"x\" \"external\"" } else { "\"x\" \"personal\"" })); }
                std::fs::remove_dir_all(root).unwrap();
                target += 1;
            }
        }
        assert!(unwritten_cases.iter().all(|&count| count > 0));
    }

    #[test]
    fn coordinated_pending_host_checks_uncertain_launch_identity_and_restores() {
        use crate::cs2_config_identity::{ConfigIdentity, SessionIdentity};
        use crate::spectator_recovery_plan::{Input, InputKind};
        let _processes = GAME_PROCESSES.lock().unwrap();
        let root = std::env::temp_dir().join(format!("mizar-host-coordinated-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let mut host = ManagedCs2::new(log);
        let cfg = root.join("steam/userdata/1/730/local/cfg"); std::fs::create_dir_all(&cfg).unwrap();
        let video = cfg.join("cs2_video.txt");
        let video_original = b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }";
        std::fs::write(&video, video_original).unwrap();
        let keys = cfg.join("cs2_user_keys_0_slot0.vcfg");
        let original = "\"config\" {\"bindings\" {\"x\" \"personal\"} \"analogbindings\" {}}";
        let candidate = "\"config\" {\"bindings\" {\"x\" \"preset\"} \"analogbindings\" {}}";
        std::fs::write(&keys, original).unwrap();
        let executable = root.join("game/bin/win64/cs2.exe"); std::fs::create_dir_all(executable.parent().unwrap()).unwrap(); std::fs::write(&executable, b"fixture").unwrap();
        let session = SessionIdentity { session_id:"host-session".into(), config:ConfigIdentity {
            account:1, video:std::fs::canonicalize(&video).unwrap(), executable:std::fs::canonicalize(&executable).unwrap(),
            keys:std::fs::canonicalize(&keys).unwrap(), slot:0, format:"vcfg".into() }};
        let x = Input { kind:InputKind::Key, name:"x".into() };
        let mut journal = host.store.prepare_coordinated(&video, &executable,
            crate::cs2_video::VideoSize::new(1920,1080).unwrap(), None, &session,
            &[x.clone()].into(), &[(x, vec!["preset".into()])].into(), candidate).unwrap();
        // Same marker and persistence entrypoint used immediately before Steam.
        journal["launchAttempted"] = json!(true); journal["launchTime"] = json!(1);
        host.store.save(&journal).unwrap();
        host.recovery_identity_fixture = Some((executable.clone(), video.clone(), 2));
        let status = host.startup_recovery_status().unwrap(); assert!(status.pending && status.uncertain);
        assert!(host.restore_at_startup(false).is_err());
        assert!(host.restore_at_startup(true).is_err()); // Wrong account: no core or key overwrite.
        assert!(host.store.load().unwrap().is_some());
        assert!(std::fs::read_to_string(&keys).unwrap().contains("\"x\" \"preset\""));
        host.recovery_identity_fixture = Some((executable.clone(), video.clone(), 1));
        host.restore_at_startup(false).unwrap();
        assert!(!host.startup_recovery_status().unwrap().pending);
        assert_eq!(std::fs::read(&video).unwrap(), video_original);
        assert!(std::fs::read_to_string(&keys).unwrap().contains("\"x\" \"personal\""));
        // A legacy full-only record is also visible and recoverable at startup.
        let x = Input { kind:InputKind::Key, name:"x".into() };
        host.store.capture_spectator_snapshot(&video, &executable, 1, &[x.clone()].into(), &[(x, vec!["preset".into()])].into()).unwrap();
        std::fs::write(&keys, candidate).unwrap();
        assert!(host.startup_recovery_status().unwrap().pending);
        host.restore_at_startup(false).unwrap();
        assert!(!host.startup_recovery_status().unwrap().pending);
        assert!(std::fs::read_to_string(&keys).unwrap().contains("\"x\" \"personal\""));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn absent_journal_cleanup_does_not_prove_an_external_game_stopped() {
        let _processes = GAME_PROCESSES.lock().unwrap();
        let root = std::env::temp_dir().join(format!("mizar-external-game-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let console = crate::cs2_console::settings(&log).unwrap();
        crate::cs2_console::set_enabled(&log, false, console["generation"].as_str()).unwrap();
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
        let process = open(external.child.id(), &log).unwrap().unwrap();
        let (created, actual_path) = identity(&process, &log).unwrap();
        let mut managed = ManagedCs2::new(log);
        let snapshot = managed.mulnx_handoff_status().unwrap();
        let observed = snapshot["processes"].as_array().unwrap().iter()
            .find(|p| p["pid"] == external.child.id()).unwrap();
        assert_eq!(observed["created"], created.to_string());
        assert_eq!(observed["executable"], actual_path.to_string_lossy().as_ref());
        assert_eq!(observed["managed"], false);
        assert!(managed.store.load().unwrap().is_none());
        assert!(managed.workspace_process().unwrap().is_none());
        drop(process);
        assert!(external.child.try_wait().unwrap().is_none());
        assert!(managed.startup_recovery_status().unwrap().running);
        assert!(managed
            .restore_at_startup(true)
            .unwrap_err()
            .contains("CS2 正在运行"));
        assert!(external.child.try_wait().unwrap().is_none());
        managed.finish().unwrap();
        let mut tracker = crate::windows_host::GameTracker::default();
        tracker.alignment_failure = Some(crate::windows_host::AlignmentFailure {
            stage: "position",
            api: Some("SetWindowPos"),
            last_error: Some(5),
        });
        tracker.group_failure = Some(crate::workspace_group::Failure {
            stage: "raise",
            api: "SetWindowPos",
            last_error: Some(5),
            target: "game",
        });
        assert!(!tracker.finish_session_feedback(&managed).unwrap());
        assert!(tracker.window_message().is_some());
        assert!(managed.confirm_game_stopped().is_err());
        // An unrelated process must never be closed by the cleanup operation.
        assert!(external.child.try_wait().unwrap().is_none());
        assert!(managed.attach_external(external.child.id(), created + 1, &actual_path).is_err());
        assert!(managed.attach_external(external.child.id(), created, &external.root.join("other.exe")).is_err());
        assert!(!managed.has_external());
        managed.store.save(&json!({"version":1,"pid":external.child.id(),"created":created,"executable":actual_path})).unwrap();
        assert!(managed.attach_external(external.child.id(), created, &actual_path).is_err());
        std::fs::remove_file(managed.store.backup_directory().join("pending.json")).unwrap();
        managed.attach_external(external.child.id(), created, &actual_path).unwrap();
        managed.bind_external_camera("first-lease".into());
        let trial_id = crate::demo_test::request_id().unwrap();
        managed.bind_external_demo(trial_id.clone());
        assert!(managed.validate_demo_running(&trial_id).is_ok());
        assert!(managed.validate_demo_running(&crate::demo_test::request_id().unwrap()).is_err());
        assert_eq!(managed.external_camera_lease(), Some("first-lease"));
        assert!(managed.preserve_settings());
        let borrowed_process = managed.workspace_process().unwrap().unwrap();
        assert!(borrowed_process.is_running());
        assert!(!borrowed_process.owned);
        let (source, source_process) = managed.console_source().unwrap().unwrap();
        assert_eq!(source["ownership"], "external");
        assert_eq!(source_process.pid, external.child.id());
        assert!(!source_process.owned);
        drop(borrowed_process);
        assert_eq!(managed.status().unwrap()["borrowed"], true);
        assert_eq!(managed.status().unwrap()["pending"], false);
        assert!(managed.store.load().unwrap().is_none());
        assert!(managed.restore_backup(true).is_err());
        assert!(!managed.start().unwrap()); // Re-entry reuses only this held instance.
        assert!(crate::production_exit::finish_then_restore(|| Err("waiting not confirmed".into()), || managed.finish()).is_err());
        assert!(managed.has_external());
        assert!(external.child.try_wait().unwrap().is_none());
        managed.finish().unwrap(); // Detach is not a process exit or recycling qualification.
        assert!(external.child.try_wait().unwrap().is_none());
        assert!(managed.confirm_game_stopped().is_err());
        assert!(managed.workspace_process().unwrap().is_none());
        assert!(managed.window_session_finished().unwrap());
        assert!(managed.preserve_settings()); // No later layout pass may resize the detached game.
        managed.attach_external(external.child.id(), created, &actual_path).unwrap();
        managed.bind_external_camera("second-lease".into());
        // A Host restart cannot silently recover a borrowed process as owned.
        let restarted = ManagedCs2::new(managed.log.clone());
        assert!(!restarted.has_external());
        assert!(restarted.external_camera_lease().is_none());
        assert!(restarted.workspace_process().unwrap().is_none());
        // The same real process identity backs an owned lease; losing it must
        // turn the next heartbeat into an invalidation rather than a renewal.
        let owned_log = crate::startup_log::DesktopLog::new(&external.root.join("owned-host"), None).unwrap();
        let mut owned_host = ManagedCs2::new(owned_log);
        owned_host.store.save(&json!({"version":1,"pid":external.child.id(),"created":created,"executable":actual_path})).unwrap();
        let owned_process = owned_host.workspace_process().unwrap().unwrap();
        owned_host.bind_managed_camera(owned_process, "managed-lease".into()).unwrap();
        assert_eq!(owned_host.managed_camera_lease(), Some(("managed-lease".into(), false)));
        external.child.kill().unwrap();
        external.child.wait().unwrap();
        assert_eq!(owned_host.managed_camera_lease(), Some(("managed-lease".into(), true)));
        owned_host.clear_managed_camera();
        assert!(owned_host.managed_camera_lease().is_none());
        managed.poll();
        assert!(managed.external_isolation_pending());
        assert_eq!(managed.external_camera_lease(), Some("second-lease"));
        managed.external_isolated();
        assert!(managed.external_camera_lease().is_none());
        assert!(!managed.external_isolation_pending());
        assert!(managed.has_external());
        assert!(managed.workspace_process().unwrap().is_none());
        assert!(managed.start().is_err()); // No replacement process is launched or selected.
        // A manually exited external game leaves no owned process or journal.
        // Repeated workspace cleanup must remain safe and complete successfully.
        managed.finish().unwrap();
        managed.finish().unwrap();
        managed.confirm_game_stopped().unwrap();
        assert!(tracker.finish_session_feedback(&managed).unwrap());
        assert_eq!(tracker.window_message(), None);
        assert!(!tracker.managed);
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
    fn pending_mulnx_launch_exposes_uncertain_recovery() {
        let root = std::env::temp_dir().join(format!("mizar-mulnx-uncertain-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let managed = ManagedCs2::new(log);
        let video = root.join("cs2_video.txt");
        std::fs::write(&video, b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }").unwrap();
        managed.store.prepare(&video, &root.join("absent/cs2.exe"), crate::cs2_video::VideoSize::new(1920, 1080).unwrap()).unwrap();
        let launch = managed.log.state_root.join("data/mulnx-launch");
        std::fs::create_dir_all(&launch).unwrap();
        std::fs::write(launch.join("pending.json"), b"{}").unwrap();
        assert_eq!(managed.status().unwrap()["phase"], "uncertain");
        assert!(managed.startup_recovery_status().unwrap().uncertain);
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
        tracker.alignment_failure = Some(crate::windows_host::AlignmentFailure {
            stage: "position",
            api: Some("SetWindowPos"),
            last_error: Some(5),
        });
        assert!(!tracker.finish_session_feedback(&managed).unwrap());
        assert!(tracker.window_message().is_some());
        assert_ne!(std::fs::read(&video).unwrap(), original);
        managed.restore_backup(true).unwrap();
        assert_eq!(std::fs::read(&video).unwrap(), original);
        assert!(managed.store.load().unwrap().is_none());
        assert!(tracker.finish_session_feedback(&managed).unwrap());
        assert_eq!(tracker.window_message(), None);
        // A damaged core record leaves restoration unknown, even with no game.
        tracker.alignment_failure = Some(crate::windows_host::AlignmentFailure {
            stage: "position",
            api: Some("SetWindowPos"),
            last_error: Some(5),
        });
        std::fs::write(managed.store.backup_directory().join("pending.json"), b"{").unwrap();
        assert!(tracker.finish_session_feedback(&managed).is_err());
        assert!(tracker.window_message().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn backup_text(path: &std::path::Path, limit: usize) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| crate::cs2_session::io_error("配置文件无法读取。", &e))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err("配置文件类型或大小不支持。".into());
    }
    let value = std::fs::read_to_string(path).map_err(|e| crate::cs2_session::io_error("配置内容无法读取。", &e))?;
    if value.len() > limit { return Err("配置内容过大。".into()); }
    Ok(value)
}
fn backup_avatar(path: &std::path::Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256*1024 { return None; }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 256*1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return None; }
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::from("data:image/png;base64,");
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0])<<16) | (u32::from(*group.get(1).unwrap_or(&0))<<8) | u32::from(*group.get(2).unwrap_or(&0));
        encoded.push(B64[((n>>18)&63)as usize]as char); encoded.push(B64[((n>>12)&63)as usize]as char);
        encoded.push(if group.len()>1 { B64[((n>>6)&63)as usize]as char } else { '=' });
        encoded.push(if group.len()>2 { B64[(n&63)as usize]as char } else { '=' });
    }
    Some(encoded)
}
