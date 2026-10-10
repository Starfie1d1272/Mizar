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
fn powershell(script: &str, log: &crate::startup_log::DesktopLog) -> Result<String, String> {
    let system = std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?;
    let executable = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(executable);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .creation_flags(0x08000000);
    crate::powershell::run(command, log, "CS2 启动配置检测", Duration::from_secs(15))
}

fn any_cs2_running(log: &crate::startup_log::DesktopLog) -> Result<bool, String> {
    Ok(!cs2_pids(log)?.is_empty())
}

fn discover(log: &crate::startup_log::DesktopLog) -> Result<(PathBuf, PathBuf, PathBuf), String> {
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
$cfg = Resolve-CfgDirectory
$game = Split-Path (Split-Path $cfg -Parent) -Parent
$exe = Join-Path $game 'bin\win64\cs2.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {{ Stop-Cs2Discovery 'selected-path-invalid' }}
$steamProcesses = @(Get-Process -Name steam -ErrorAction SilentlyContinue)
if ($steamProcesses.Count -eq 0) {{ Stop-Cs2Discovery 'steam-not-running' }}
if ($steamProcesses.Count -ne 1) {{ Stop-Cs2Discovery 'steam-not-unique' }}
$steamExe = $steamProcesses[0].Path
if (!(Test-Path -LiteralPath $steamExe -PathType Leaf)) {{ Stop-Cs2Discovery 'steam-not-running' }}
try {{ $accountValue = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam\ActiveProcess' -ErrorAction Stop).ActiveUser }} catch {{ Stop-Cs2Discovery 'steam-account-unavailable' }}
if ($accountValue -lt 0) {{ $accountValue = [long]$accountValue + 4294967296 }}
$account = [uint32]$accountValue
if ($account -eq 0) {{ Stop-Cs2Discovery 'steam-account-unavailable' }}
$videos = @()
foreach ($root in @(Get-SteamInstallRoots)) {{
  $candidate = Join-Path $root ('userdata\' + $account + '\730\local\cfg\cs2_video.txt')
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {{ $videos += (Resolve-Path -LiteralPath $candidate).Path }}
}}
$videos = @($videos | Select-Object -Unique)
if ($videos.Count -eq 0) {{ Stop-Cs2Discovery 'video-config-missing' }}
if ($videos.Count -ne 1) {{ Stop-Cs2Discovery 'video-config-ambiguous' }}
@{{executable=(Resolve-Path -LiteralPath $exe).Path; video=$videos[0]; steam=$steamExe}} | ConvertTo-Json -Compress
"#
    );
    let output = powershell(&script, log)?;
    let value = crate::powershell::parse(log, "CS2 启动配置检测", &output)?;
    let path = |key: &str| {
        value[key]
            .as_str()
            .map(PathBuf::from)
            .ok_or_else(|| "CS2 配置路径缺失。".to_string())
    };
    Ok((path("executable")?, path("video")?, path("steam")?))
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
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snapshot == -1 {
        return Err(win32_failure(
            log,
            "CreateToolhelp32Snapshot",
            "无法检查 CS2 是否运行，未修改游戏设置。",
        ));
    }
    let snapshot = Process(snapshot);
    let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
    entry.size = std::mem::size_of::<ProcessEntry>() as u32;
    let mut pids = Vec::new();
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while found != 0 {
        let len = entry.executable.iter().position(|v| *v == 0).unwrap_or(260);
        if String::from_utf16_lossy(&entry.executable[..len]).eq_ignore_ascii_case("cs2.exe") {
            pids.push(entry.pid);
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    if unsafe { GetLastError() } != 18 {
        return Err(win32_failure(log, "Process32NextW", "CS2 进程检查未完成。"));
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
            "无法确认 CS2 进程身份，未关闭游戏或恢复配置。",
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
            "无法确认 CS2 启动身份。",
        ));
    }
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err(win32_failure(
            log,
            "QueryFullProcessImageNameW",
            "无法确认 CS2 程序路径。",
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

unsafe extern "system" fn close_window(window: isize, pid: isize) -> i32 {
    let mut found = 0;
    GetWindowThreadProcessId(window, &mut found);
    if found == pid as u32 {
        PostMessageW(window, 0x0010, 0, 0);
    }
    1
}

pub struct ManagedCs2 {
    store: SessionStore,
    log: crate::startup_log::DesktopLog,
    message: Option<String>,
    launch_observation: Option<Value>,
}
impl ManagedCs2 {
    pub fn new(log: crate::startup_log::DesktopLog) -> Self {
        Self {
            store: SessionStore::new(log.state_root.clone()),
            log,
            message: None,
            launch_observation: None,
        }
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
            json!({"qualityPreset": preferences.quality.name(), "frameRateLimit":preferences.frame_rate_limit, "pending":pending.is_some(), "running":running, "message":self.message, "busy":false, "phase": if pending.as_ref().is_some_and(crate::cs2_session::unconfirmed_launch) {"uncertain"} else if running {"running"} else if pending.is_some() {"pending"} else {"idle"}}),
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
            return Ok(());
        }
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
        self.store.restore()?;
        self.message = Some("原设置已恢复。".into());
        Ok(())
    }
    pub fn poll(&mut self) {
        if let Err(error) = self.recover(false) {
            self.message = Some(error);
        }
    }
    pub fn start(&mut self) -> Result<bool, String> {
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
        let size = crate::windows_host::launch_viewport()?;
        let mut journal = self
            .store
            .prepare_with_frame_rate(&video, &executable, size)?;
        // Durable ambiguous-launch marker: a crash between spawn and identity save
        // must never restore settings while an unconfirmed game is running.
        journal["launchAttempted"] = json!(true);
        let mut time = FileTime::default();
        unsafe {
            GetSystemTimeAsFileTime(&mut time);
        }
        let launch_time = ((time.high as u64) << 32) | time.low as u64;
        journal["launchTime"] = json!(launch_time);
        self.store.save(&journal)?;
        let launch: Result<bool, String> = (|| {
            Command::new(&steam)
                .current_dir(steam.parent().ok_or("Steam 程序目录无效。")?)
                .args(LAUNCH_ARGS)
                .args([
                    "-w",
                    &size.width.to_string(),
                    "-h",
                    &size.height.to_string(),
                    "+fps_max",
                    &journal["frameRateLimit"]
                        .as_u64()
                        .ok_or("帧率启动参数缺失。")?
                        .to_string(),
                ])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| {
                    self.log.event("cs2_launch", "failure", Some(&format!("stage=steam_spawn; launchTime={launch_time}; code={:?}; cause={error:?}", error.raw_os_error())));
                    journal["launchAttempted"] = json!(false);
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
        if let Err(error) = &launch {
            self.message = Some(error.clone());
            if let Err(recovery_error) = self.recover(false) {
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
        let result = self.recover(confirm_steam_cancelled);
        if let Err(error) = &result {
            self.message = Some(error.clone());
        }
        result
    }
    pub fn finish(&mut self) -> Result<(), String> {
        // Poll once to adopt a uniquely identified late launch before closing it.
        self.poll();
        if let Some(value) = self.store.load()? {
            if let Some(process) = owned_process(&value, &self.log)? {
                let pid = value["pid"].as_u64().ok_or("CS2 进程记录缺失。")?;
                unsafe {
                    EnumWindows(close_window, pid as isize);
                }
                // Hold the verified process handle while waiting; PID reuse does
                // not make another process an owned game.
                if unsafe { WaitForSingleObject(process.0, 15000) } != 0 {
                    self.message = Some("CS2 尚未退出，请手动退出游戏后重试恢复。".into());
                    return Err(self.message.clone().unwrap());
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
            Ok(()) => Ok(()),
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
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slow_launch_stays_pending_and_requires_explicit_cancel_before_restoration() {
        let root = std::env::temp_dir().join(format!("mizar-waiting-{}", std::process::id()));
        let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
        let mut managed = ManagedCs2::new(log);
        let video = root.join("video.txt");
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
        assert!(managed.store.load().unwrap().is_some());
        assert!(managed.finish().is_err());
        assert_ne!(std::fs::read(&video).unwrap(), original);
        managed.restore_backup(true).unwrap();
        assert_eq!(std::fs::read(&video).unwrap(), original);
        assert!(managed.store.load().unwrap().is_none());
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
