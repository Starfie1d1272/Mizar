//! Windows process discovery and held identity. Session transitions belong to ManagedCs2.
use serde_json::json;
use std::{
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
const LAUNCH_ARGS: &[&str] = &[
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

pub(crate) fn any_cs2_running(log: &crate::startup_log::DesktopLog) -> Result<bool, String> {
    Ok(!cs2_pids(log)?.is_empty())
}

pub(crate) struct SteamLaunch {
    process: SteamProcess,
    pub(crate) account: u32,
}
impl SteamLaunch {
    pub(crate) fn validate(&self, log: &crate::startup_log::DesktopLog) -> Result<(), String> {
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

impl SteamLaunch {
    pub(crate) fn validate_window_options(
        &self,
        size: crate::cs2_video::VideoSize,
        protect_previous_console: bool,
        log: &crate::startup_log::DesktopLog,
    ) -> Result<(), String> {
        let output = powershell(
            r#"
$context = Get-SteamLaunchContext -NativeIdentity $nativeSteam
$path = Join-Path (Split-Path -Parent $context.executable) ('userdata\' + $context.account + '\config\localconfig.vdf')
$options = ''
if (Test-Path -LiteralPath $path -ErrorAction Stop) {
  $file = Get-Item -LiteralPath $path -ErrorAction Stop
  if (!$file.PSIsContainer -and $file.Length -le 8MB) {
    $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
    $tokens = @([regex]::Matches($text, '"(?:\\.|[^"\\])*"|[{}]|//[^\r\n]*|[^\s{}"]+') | ForEach-Object { $_.Value } | Where-Object { -not $_.StartsWith('//') })
    $data = Read-SteamVdfObject $tokens @{ Index = 0 }
    foreach ($key in @('UserLocalConfigStore','Software','Valve','Steam','apps','730')) {
      if ($null -eq $data) { break }
      if ($data -isnot [hashtable]) { throw 'steam-launch-options-invalid' }
      $data = $data[$key]
    }
    if ($null -ne $data) {
      if ($data -isnot [hashtable]) { throw 'steam-launch-options-invalid' }
      if ($data.ContainsKey('LaunchOptions')) {
        if ($data.LaunchOptions -isnot [string] -or $data.LaunchOptions.Length -gt 65536) { throw 'steam-launch-options-invalid' }
        $options = $data.LaunchOptions
      }
    }
  } else { throw 'steam-launch-options-invalid' }
}
@{account=$context.account; options=$options} | ConvertTo-Json -Compress
"#,
            &self.process,
            Some(self.account),
            log,
        )?;
        let value = crate::powershell::parse(log, "Steam 窗口启动参数核验", &output)?;
        if value["account"].as_u64() != Some(u64::from(self.account)) {
            return Err(steam_failure(log, "steam-account-unavailable"));
        }
        check_steam_window_options(
            value["options"]
                .as_str()
                .ok_or("无法核实 Steam 启动参数。")?,
            size,
            protect_previous_console,
        )
    }
}

// Saved Steam options are read-only. Use Windows' own argument parser rather
// than rejecting valid quoting or guessing the priority of duplicate switches.
fn check_steam_window_options(
    options: &str,
    size: crate::cs2_video::VideoSize,
    protect_previous_console: bool,
) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            UI::Shell::CommandLineToArgvW,
        },
    };
    let error = "无法安全核实 Steam 窗口启动参数，请检查 CS2 的启动选项后重试。";
    if options.len() > 65536 || options.contains(['\r', '\n', '\0']) {
        return Err(error.into());
    }
    let command: Vec<u16> = format!("cs2.exe {options}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut count = 0;
    let arguments = unsafe { CommandLineToArgvW(PCWSTR(command.as_ptr()), &mut count) };
    if arguments.is_null() {
        return Err(error.into());
    }
    let words = if (1..=257).contains(&count) {
        unsafe { std::slice::from_raw_parts(arguments.add(1), (count - 1) as usize) }
            .iter()
            .map(|word| unsafe { word.to_string() }.map(|word| word.to_ascii_lowercase()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| error.to_string())
    } else {
        Err(error.to_string())
    };
    unsafe { LocalFree(Some(HLOCAL(arguments.cast()))) };
    let words = words?;
    check_steam_window_arguments(&words, size)?;
    if protect_previous_console {
        check_console_preserving_arguments(&words)?;
    }
    Ok(())
}

// We cannot override Steam's saved options without changing the user's settings.
// Only this explicit conflict, not optional archive failure, may stop submission.
fn check_console_preserving_arguments(words: &[String]) -> Result<(), String> {
    if words.iter().any(|word| {
        let flag = word.split(['=', ':']).next().unwrap_or(word);
        matches!(
            flag,
            "-condebug" | "-conclearlog" | "+con_logfile" | "+con_logfile_open"
        )
    }) {
        return Err("上一场原始控制台未能归档，而 Steam 已保存的启动选项仍会写入或清空日志。请先归档 console.log，或移除 -condebug、-conclearlog 及 con_logfile 启动参数后重试；原日志和配置备份已保留。".into());
    }
    Ok(())
}

fn check_steam_window_arguments(
    words: &[String],
    size: crate::cs2_video::VideoSize,
) -> Result<(), String> {
    let error = "Steam 已保存的窗口启动参数与工作台冲突。请在 Steam 的 CS2 启动选项中移除全屏和尺寸覆盖后重试；启动前的配置修改仍可恢复。";
    let mut i = 0;
    while i < words.len() {
        let word = words[i].as_str();
        if matches!(
            word,
            "-fullscreen" | "-full" | "-border" | "+mat_setvideomode" | "+r_fullscreen"
        ) || word == "%command%"
        {
            return Err(error.into());
        }
        let expected = match word {
            "-w" | "-width" => Some(size.width),
            "-h" | "-height" => Some(size.height),
            _ => None,
        };
        if let Some(expected) = expected {
            i += 1;
            if words.get(i).and_then(|value| value.parse::<i32>().ok()) != Some(expected) {
                return Err(error.into());
            }
        } else if word.split_once('=').is_some_and(|(flag, _)| {
            matches!(
                flag,
                "-w" | "-width"
                    | "-h"
                    | "-height"
                    | "-fullscreen"
                    | "-full"
                    | "-windowed"
                    | "-window"
                    | "-sw"
                    | "-noborder"
                    | "-border"
            )
        }) {
            return Err(error.into());
        }
        i += 1;
    }
    Ok(())
}

pub(crate) fn discover(
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

pub(crate) struct Process(Handle);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub(crate) fn cs2_pids(log: &crate::startup_log::DesktopLog) -> Result<Vec<u32>, String> {
    process_pids("cs2.exe", log)
}
pub(crate) fn process_pids(
    name: &str,
    log: &crate::startup_log::DesktopLog,
) -> Result<Vec<u32>, String> {
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
pub(crate) fn process_parent(
    pid: u32,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<u32>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snapshot == -1 {
        return Err(win32_failure(
            log,
            "CreateToolhelp32Snapshot",
            "无法检查游戏进程，请重试。",
        ));
    }
    let snapshot = Process(snapshot);
    let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while found != 0 {
        if entry.pid == pid {
            return Ok(Some(entry.parent));
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != 18 {
        return Err(win32_failure(
            log,
            "Process32NextW",
            "无法检查游戏进程，请重试。",
        ));
    }
    Ok(None)
}
pub(crate) fn open(
    pid: u32,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<Process>, String> {
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
pub(crate) fn identity(
    process: &Process,
    log: &crate::startup_log::DesktopLog,
) -> Result<(u64, PathBuf), String> {
    read_identity(process, log)?
        .ok_or_else(|| "进程程序路径暂时无法读取，请稍后重试；原启动和配置记录仍保留。".into())
}
/// A temporarily unreadable image is unknown, never proof that the process is absent.
/// Only the submitted-launch observer may wait for another complete observation.
pub(crate) fn read_identity(
    process: &Process,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<(u64, PathBuf)>, String> {
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
        let code = unsafe { GetLastError() };
        let message = identity_failure(
            log,
            process,
            "QueryFullProcessImageNameW",
            "无法确认进程程序路径。",
            Some(((created.high as u64) << 32) | created.low as u64),
        );
        if code == 5 && unsafe { WaitForSingleObject(process.0, 0) } == 258 {
            return Ok(None);
        }
        return Err(message);
    }
    Ok(Some((
        ((created.high as u64) << 32) | created.low as u64,
        PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])),
    )))
}
fn identity_failure(
    log: &crate::startup_log::DesktopLog,
    process: &Process,
    api: &str,
    message: &str,
    created: Option<u64>,
) -> String {
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

pub(crate) fn same_executable(actual: &std::path::Path, expected: &str) -> bool {
    let normalize = |path: &std::path::Path| {
        crate::powershell::provider_path(path)
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    normalize(actual) == normalize(std::path::Path::new(expected))
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

/// Called only with a held, identity-verified process selected for this operation.
pub(crate) fn close_owned_process(
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

/// A verified, Mizar-owned session process held open during window operations. Keeping the
/// handle prevents PID reuse from turning a stale window into another game.
#[derive(Clone)]
pub struct WorkspaceProcess {
    process: Arc<Process>,
    pub pid: u32,
    pub created: u64,
}
impl WorkspaceProcess {
    pub fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) == 258 }
    }
}

impl Process {
    pub(crate) fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 0) == 258 }
    }
    pub(crate) fn has_exited(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 0) == 0 }
    }
    pub(crate) fn running(
        &self,
        log: &crate::startup_log::DesktopLog,
        message: &str,
    ) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(self.0, 0) } {
            0 => Ok(false),
            258 => Ok(true),
            _ => Err(win32_failure(log, "WaitForSingleObject", message)),
        }
    }
}
impl SteamLaunch {
    pub(crate) fn directory(&self) -> Result<&Path, String> {
        self.process
            .executable
            .parent()
            .ok_or_else(|| "Steam 程序目录无效。".into())
    }
    pub(crate) fn command(&self, size: crate::cs2_video::VideoSize) -> Result<Command, String> {
        let mut command = Command::new(&self.process.executable);
        command.current_dir(self.directory()?);
        command.args(LAUNCH_ARGS).args([
            "-w",
            &size.width.to_string(),
            "-h",
            &size.height.to_string(),
        ]);
        Ok(command)
    }
}
pub(crate) fn launch_timestamp() -> u64 {
    let mut time = FileTime::default();
    unsafe {
        GetSystemTimeAsFileTime(&mut time);
    }
    ((time.high as u64) << 32) | time.low as u64
}
impl WorkspaceProcess {
    /// The caller has verified PID, creation time and installation with this held handle.
    pub(crate) fn hold_verified(process: Process, pid: u32, created: u64) -> Self {
        Self {
            process: Arc::new(process),
            pid,
            created,
        }
    }
}
pub(crate) fn submit_steam(command: &mut Command) -> std::io::Result<()> {
    command
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

/// A stored identity grants control only while the held OS identity still matches.
pub(crate) fn verified_process(
    expected: Option<&crate::cs2_process_identity::ProcessIdentity>,
    log: &crate::startup_log::DesktopLog,
) -> Result<Option<WorkspaceProcess>, String> {
    let Some(expected) = expected else {
        return Ok(None);
    };
    let Some(process) = open(expected.pid, log)? else {
        return Ok(None);
    };
    if !process.running(log, "无法确认 CS2 是否退出，备份仍保留。")? {
        return Ok(None);
    }
    let (created, executable) = identity(&process, log)?;
    if created != expected.created || !same_executable(&executable, &expected.executable) {
        return Ok(None);
    }
    Ok(Some(WorkspaceProcess::hold_verified(
        process,
        expected.pid,
        created,
    )))
}
impl WorkspaceProcess {
    pub(crate) fn close(&self, log: &crate::startup_log::DesktopLog) -> Result<(), String> {
        close_owned_process(&self.process, self.pid, self.created, log)
    }
}
