use crate::cs2_session::SessionStore;
use serde_json::{json, Value};
use std::{
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
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
fn powershell(script: &str, state_root: &Path) -> Result<String, String> {
    let system = std::env::var_os("SystemRoot").ok_or("Windows 系统目录不可用。")?;
    let executable = PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable)
        .env_remove("PSModulePath")
        .env("MIZAR_STATE_ROOT", state_root)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "CS2 配置工具未能启动。")?;
    let until = Instant::now() + Duration::from_secs(15);
    while child
        .try_wait()
        .map_err(|_| "CS2 配置工具状态不可用。")?
        .is_none()
    {
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err("CS2 配置检测超时，请重试。".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let result = child
        .wait_with_output()
        .map_err(|_| "CS2 配置工具结果不可用。")?;
    if !result.status.success() {
        return Err(crate::cs2_diagnostics::failure(&result.stdout));
    }
    String::from_utf8(result.stdout).map_err(|_| "CS2 配置检测结果无法读取。".into())
}

fn any_cs2_running() -> Result<bool, String> {
    Ok(!cs2_pids()?.is_empty())
}

fn discover(state_root: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let discovery = DISCOVERY.trim_start_matches('\u{feff}');
    let script = format!(
        r#"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
{discovery}
trap {{
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
    let value: Value = serde_json::from_str(powershell(&script, state_root)?.trim())
        .map_err(|_| "CS2 配置检测结果无效。")?;
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
fn cs2_pids() -> Result<Vec<u32>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snapshot == -1 {
        return Err("无法检查 CS2 是否运行，未修改游戏设置。".into());
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
        return Err("CS2 进程检查未完成。".into());
    }
    Ok(pids)
}
fn open(pid: u32) -> Result<Option<Process>, String> {
    let handle = unsafe { OpenProcess(0x1000 | 0x100000, 0, pid) };
    if handle != 0 {
        Ok(Some(Process(handle)))
    } else if unsafe { GetLastError() } == 87 {
        Ok(None)
    } else {
        Err("无法确认 CS2 进程身份，未关闭游戏或恢复配置。".into())
    }
}
fn identity(process: &Process) -> Result<(u64, PathBuf), String> {
    let mut created = FileTime::default();
    let mut exit = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    if unsafe { GetProcessTimes(process.0, &mut created, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err("无法确认 CS2 启动身份。".into());
    }
    let mut buffer = vec![0u16; 32768];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err("无法确认 CS2 程序路径。".into());
    }
    Ok((
        ((created.high as u64) << 32) | created.low as u64,
        PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize])),
    ))
}
fn owned_process(value: &Value) -> Result<Option<Process>, String> {
    let Some(pid) = value["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
    else {
        return Ok(None);
    };
    let Some(process) = open(pid)? else {
        return Ok(None);
    };
    if unsafe { WaitForSingleObject(process.0, 0) } == 0 {
        return Ok(None);
    }
    let (created, executable) = identity(&process)?;
    let expected = value["executable"]
        .as_str()
        .ok_or("CS2 进程路径记录缺失。")?;
    if value["created"].as_u64() != Some(created)
        || !executable.to_string_lossy().eq_ignore_ascii_case(expected)
    {
        return Ok(None);
    }
    Ok(Some(process))
}
fn launched_process(value: &Value) -> Result<Option<(u32, u64)>, String> {
    let launch_time = value["launchTime"]
        .as_u64()
        .ok_or("CS2 启动时间记录缺失。")?;
    let executable = value["executable"]
        .as_str()
        .ok_or("CS2 程序路径记录缺失。")?;
    let mut candidates = Vec::new();
    for pid in cs2_pids()? {
        if let Some(process) = open(pid)? {
            let (created, actual) = identity(&process)?;
            if created >= launch_time && actual.to_string_lossy().eq_ignore_ascii_case(executable) {
                candidates.push((pid, created));
            }
        }
    }
    match candidates.as_slice() {
        [] => Ok(None),
        [found] => Ok(Some(*found)),
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
    message: Option<String>,
}
impl ManagedCs2 {
    pub fn new(root: PathBuf) -> Self {
        Self {
            store: SessionStore::new(root),
            message: None,
        }
    }
    pub fn status(&self) -> Result<Value, String> {
        let pending = self.store.load()?;
        let running = pending
            .as_ref()
            .map(owned_process)
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
            if let Some((pid, created)) = launched_process(&value)? {
                value["pid"] = json!(pid);
                value["created"] = json!(created);
                self.store.save(&value)?;
                self.message = None;
            } else if !confirm_steam_cancelled {
                return Err("Steam 启动结果待确认。若游戏稍后打开会继续跟踪；请先取消 Steam 中的启动请求，再手动恢复备份。".into());
            }
        }
        if owned_process(&value)?.is_some() {
            if confirm_steam_cancelled {
                return Err("CS2 正在运行，请先退出游戏再恢复备份。".into());
            }
            return Ok(());
        }
        if any_cs2_running()? {
            return Err("等待 CS2 退出后恢复原配置。".into());
        }
        // Allow the game to finish saving after its process exits.
        thread::sleep(Duration::from_millis(1500));
        if any_cs2_running()? {
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
            if owned_process(&value)?.is_some() {
                return Ok(false);
            }
            self.recover(false)?;
        }
        if any_cs2_running()? {
            return Err("请先退出已打开的 CS2，再由 Mizar 启动。".into());
        }
        let backup = self.store.backup_directory();
        let state_root = backup
            .parent()
            .and_then(Path::parent)
            .ok_or("运行数据目录无效。")?;
        let (executable, video, steam) = discover(state_root)?;
        if any_cs2_running()? {
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
                .map_err(|_| {
                    journal["launchAttempted"] = json!(false);
                    let _ = self.store.save(&journal);
                    "CS2 未能启动。"
                })?;
            // Steam's launcher PID is not the game PID. Claim only one newly
            // created process from the resolved installation, after a no-game
            // precondition; keep ambiguous launches pending for manual recovery.
            let until = Instant::now() + Duration::from_secs(45);
            let (pid, created) = loop {
                if let Some(found) = launched_process(&journal)? {
                    break found;
                }
                if Instant::now() >= until {
                    return Err(
                        "等待 CS2 启动超时，请检查 Steam；若游戏已打开，请先退出再重试恢复。"
                            .into(),
                    );
                }
                thread::sleep(Duration::from_millis(200));
            };
            journal["pid"] = json!(pid);
            journal["created"] = json!(created);
            self.store.save(&journal)?;
            // Child is intentionally outside Companion's Runtime Job. Never kill
            // by name; the durable PID + creation time + executable owns cleanup.
            Ok(true)
        })();
        if let Err(error) = &launch {
            self.message = Some(error.clone());
            let _ = self.recover(false);
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
            if let Some(process) = owned_process(&value)? {
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
        let process = open(pid).unwrap().unwrap();
        let (created, path) = identity(&process).unwrap();
        let mut journal = json!({"pid":pid,"created":created,"executable":path});
        assert!(owned_process(&journal).unwrap().is_some());
        journal["created"] = json!(created + 1);
        assert!(owned_process(&journal).unwrap().is_none());
        journal["created"] = json!(created);
        journal["executable"] = json!("C:\\different\\cs2.exe");
        assert!(owned_process(&journal).unwrap().is_none());
    }
}
