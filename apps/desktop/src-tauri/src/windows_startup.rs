use std::{ffi::c_void, io, os::windows::io::AsRawHandle, path::Path, process::Child, sync::Arc};

#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority: u32,
    scheduling_class: u32,
}
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_ops: u64,
    write_ops: u64,
    other_ops: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io: IoCounters,
    process_memory: usize,
    job_memory: usize,
    peak_process: usize,
    peak_job: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> isize;
    fn GetLastError() -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> isize;
    fn SetInformationJobObject(job: isize, class: i32, info: *const c_void, length: u32) -> i32;
    fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    fn TerminateJobObject(job: isize, exit_code: u32) -> i32;
    fn CreateEventW(
        attributes: *const c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
    ) -> isize;
    fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> isize;
    fn SetEvent(event: isize) -> i32;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
}
#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn FindWindowW(class: *const u16, title: *const u16) -> isize;
    fn ShowWindowAsync(hwnd: isize, command: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn FlashWindowEx(info: *const FlashInfo) -> i32;
}
#[repr(C)]
struct FlashInfo {
    size: u32,
    window: isize,
    flags: u32,
    count: u32,
    timeout: u32,
}
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: isize,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> isize;
}

pub struct DesktopMutex(isize);
impl DesktopMutex {
    pub fn acquire() -> io::Result<Option<Self>> {
        let name: Vec<u16> = "Global\\MizarDesktop\0".encode_utf16().collect();
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { GetLastError() } == 183 {
            unsafe {
                CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(Self(handle)))
    }
}
impl Drop for DesktopMutex {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Only newly spawned wrappers join this job. The stdin handshake prevents them
/// from starting Companion until assignment, so all descendants inherit ownership.
pub struct RuntimeJob(isize);
impl RuntimeJob {
    pub fn new() -> io::Result<Self> {
        let job = Self(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        if job.0 == 0 {
            return Err(io::Error::last_os_error());
        }
        job.kill_on_close(true)?;
        Ok(job)
    }
    pub fn kill_on_close(&self, enabled: bool) -> io::Result<()> {
        let mut limits = ExtendedLimits::default();
        limits.basic.flags = if enabled { 0x2000 } else { 0 };
        if unsafe {
            SetInformationJobObject(
                self.0,
                9,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<ExtendedLimits>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    pub fn assign(&self, child: &Child) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as isize) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
impl Drop for RuntimeJob {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct EventHandle(isize);
impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// The Host retains DesktopMutex until the helper acknowledges its own handle.
/// This event only coordinates that handoff; it never authorizes installation.
pub struct UpdateHandoff {
    event: EventHandle,
    name: String,
}
impl UpdateHandoff {
    pub fn new() -> io::Result<Self> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let name = format!("Global\\MizarUpdateReady-{}-{nonce}", std::process::id());
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
        if handle == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            event: EventHandle(handle),
            name,
        })
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn ready(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.event.0, 0) } {
            0 => Ok(true),
            258 => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

pub fn update_in_progress() -> io::Result<bool> {
    let name: Vec<u16> = "Global\\MizarUpdateActive\0".encode_utf16().collect();
    let handle = unsafe { OpenEventW(0x00100000, 0, name.as_ptr()) };
    if handle == 0 {
        return if unsafe { GetLastError() } == 2 {
            Ok(false)
        } else {
            Err(io::Error::last_os_error())
        };
    }
    drop(EventHandle(handle));
    Ok(true)
}

pub fn focus_update_window() -> bool {
    let title: Vec<u16> = "Mizar 应用更新\0".encode_utf16().collect();
    let handle = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if handle == 0 {
        return false;
    }
    unsafe {
        ShowWindowAsync(handle, 9);
        if SetForegroundWindow(handle) != 0 {
            return true;
        }
        FlashWindowEx(&FlashInfo {
            size: std::mem::size_of::<FlashInfo>() as u32,
            window: handle,
            flags: 2,
            count: 3,
            timeout: 0,
        });
        false
    }
}

/// Never keep a rejected product image mapped while the writer replaces it.
/// The tool's own window provides feedback even if Windows refuses focus.
pub fn reject_update_start(headless: bool) -> io::Result<bool> {
    if !update_in_progress()? {
        return Ok(false);
    }
    if !headless {
        focus_update_window();
    }
    eprintln!("Mizar 正在安装更新或恢复旧版，请等待完成后再启动。");
    Ok(true)
}
#[derive(Clone)]
pub struct ExitSignal(Arc<EventHandle>);

/// A request to the live Host, consumed once so failed restoration can be retried.
pub struct ExitRequest(EventHandle);
impl ExitRequest {
    fn name(scope: &str) -> Vec<u16> {
        format!("Global\\MizarDesktopExitRequest-{scope}\0")
            .encode_utf16()
            .collect()
    }
    pub fn new(scope: &str) -> io::Result<Self> {
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, Self::name(scope).as_ptr()) };
        if handle == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(EventHandle(handle)))
        }
    }
    pub fn requested(&self) -> bool {
        unsafe { WaitForSingleObject(self.0 .0, 0) == 0 }
    }
    pub fn notify(scope: &str) -> io::Result<bool> {
        let handle = unsafe { OpenEventW(0x0002, 0, Self::name(scope).as_ptr()) };
        if handle == 0 {
            return if unsafe { GetLastError() } == 2 {
                Ok(false)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        let result = unsafe { SetEvent(handle) };
        unsafe {
            CloseHandle(handle);
        }
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(true)
        }
    }
    pub fn exists(scope: &str) -> io::Result<bool> {
        let handle = unsafe { OpenEventW(0x00100000, 0, Self::name(scope).as_ptr()) };
        if handle == 0 {
            return if unsafe { GetLastError() } == 2 {
                Ok(false)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        unsafe {
            CloseHandle(handle);
        }
        Ok(true)
    }
}

/// Coalesce repeated launches and reopen the existing preparation window.
pub struct ActivationSignal(EventHandle);
impl ActivationSignal {
    const NAME: &'static str = "Global\\MizarDesktopActivate\0";
    pub fn new() -> io::Result<Self> {
        let name: Vec<u16> = Self::NAME.encode_utf16().collect();
        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if handle == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(EventHandle(handle)))
        }
    }
    pub fn requested(&self) -> bool {
        unsafe { WaitForSingleObject(self.0 .0, 0) == 0 }
    }
    pub fn notify() {
        let name: Vec<u16> = Self::NAME.encode_utf16().collect();
        let handle = unsafe { OpenEventW(0x0002, 0, name.as_ptr()) };
        if handle != 0 {
            unsafe {
                SetEvent(handle);
                CloseHandle(handle);
            }
        }
    }
}
fn exit_event_name(scope: &str) -> Vec<u16> {
    format!("Global\\MizarDesktopStop-{scope}\0")
        .encode_utf16()
        .collect()
}
impl ExitSignal {
    pub fn new(scope: &str) -> io::Result<Self> {
        let handle =
            unsafe { CreateEventW(std::ptr::null(), 1, 0, exit_event_name(scope).as_ptr()) };
        if handle == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(Arc::new(EventHandle(handle))))
        }
    }
    pub fn requested(&self) -> bool {
        unsafe { WaitForSingleObject(self.0 .0, 0) == 0 }
    }
    // Call only after the token- and artifact-verified stop command succeeds.
    pub fn notify_stopped(scope: &str) {
        let handle = unsafe { OpenEventW(0x0002, 0, exit_event_name(scope).as_ptr()) };
        if handle != 0 {
            unsafe {
                SetEvent(handle);
                CloseHandle(handle);
            }
        }
    }
}

const WEBVIEW2_DOWNLOAD_PAGE: &str =
    "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";

pub(crate) fn open_recovery_target(target: &str) -> io::Result<()> {
    let open: Vec<u16> = "open\0".encode_utf16().collect();
    let target: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            0,
            open.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result <= 32 {
        Err(io::Error::other(format!("ShellExecuteW failed ({result})")))
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum WebviewRecoveryAction {
    Download,
    Recheck,
    Logs,
    Exit,
}

fn webview_recovery_choice(failed_recheck: bool) -> Result<WebviewRecoveryAction, String> {
    use windows::{
        core::PCWSTR,
        Win32::UI::Controls::{
            TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
        },
    };
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let title = wide("Mizar 启动失败");
    let instruction = wide(if failed_recheck {
        "仍未检测到界面运行库，请安装后重新检测。"
    } else {
        "缺少界面运行库，请安装后重新检测。"
    });
    let content = wide("“前往安装”将打开微软官方页面。详细原因可在日志中查看。");
    let installation = wide("选择 Microsoft Edge WebView2 Evergreen Standalone Installer（x64）安装或修复，完成后选择“重新检测”。若设备限制安装，请联系管理员。Mizar 不会自动下载或执行安装程序。");
    let expand = wide("安装说明");
    let collapse = wide("收起安装说明");
    let labels = [
        wide("前往安装"),
        wide("重新检测"),
        wide("查看日志"),
        wide("退出"),
    ];
    let buttons: Vec<_> = labels
        .iter()
        .enumerate()
        .map(|(index, label)| TASKDIALOG_BUTTON {
            nButtonID: 1001 + index as i32,
            pszButtonText: PCWSTR(label.as_ptr()),
        })
        .collect();
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        pszMainInstruction: PCWSTR(instruction.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        pszExpandedInformation: PCWSTR(installation.as_ptr()),
        pszExpandedControlText: PCWSTR(expand.as_ptr()),
        pszCollapsedControlText: PCWSTR(collapse.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: 1001,
        ..Default::default()
    };
    let mut selected = 0;
    unsafe { TaskDialogIndirect(&config, Some(&mut selected), None, None) }
        .map_err(|error| format!("WebView2 recovery dialog: {error:?}"))?;
    Ok(match selected {
        1001 => WebviewRecoveryAction::Download,
        1002 => WebviewRecoveryAction::Recheck,
        1003 => WebviewRecoveryAction::Logs,
        _ => WebviewRecoveryAction::Exit,
    })
}

fn run_webview_recovery(
    mut choose: impl FnMut(bool) -> Result<WebviewRecoveryAction, String>,
    mut check: impl FnMut() -> Result<String, String>,
    mut open: impl FnMut(WebviewRecoveryAction) -> io::Result<()>,
    mut record: impl FnMut(&str, &str, Option<&str>),
) -> bool {
    let mut failed = false;
    loop {
        match choose(failed) {
            Ok(WebviewRecoveryAction::Recheck) => match check() {
                Ok(version) => {
                    record("webview2_recheck", "success", Some(&version));
                    return true;
                }
                Err(error) => {
                    record("webview2_recheck", "failure", Some(&error));
                    failed = true;
                }
            },
            Ok(action @ (WebviewRecoveryAction::Download | WebviewRecoveryAction::Logs)) => {
                if let Err(error) = open(action) {
                    record(
                        "webview2_recovery_action",
                        "failure",
                        Some(&error.to_string()),
                    );
                }
            }
            Ok(WebviewRecoveryAction::Exit) => return false,
            Err(error) => {
                record("webview2_recovery_action", "failure", Some(&error));
                return false;
            }
        }
    }
}

pub fn recover_webview(
    log: &crate::startup_log::DesktopLog,
    check: impl FnMut() -> Result<String, String>,
) -> bool {
    run_webview_recovery(
        |failed| {
            let choice = webview_recovery_choice(failed);
            if choice.is_err() {
                failure_dialog("WebView2 Runtime 不可用。请在微软官方页面安装或修复 Evergreen Standalone Installer（x64），然后重新启动 Mizar。网吧限制安装时请联系管理员。\nhttps://developer.microsoft.com/en-us/microsoft-edge/webview2/", Some(&log.directory));
            }
            choice
        },
        check,
        |action| {
            let target = match action {
                WebviewRecoveryAction::Download => WEBVIEW2_DOWNLOAD_PAGE.to_owned(),
                WebviewRecoveryAction::Logs => log.directory.to_string_lossy().into_owned(),
                _ => unreachable!(),
            };
            let outcome = open_recovery_target(&target);
            if outcome.is_err() {
                let message = match action {
                    WebviewRecoveryAction::Download => format!("无法打开安装页面。\n\n按 Ctrl+C 复制此提示，在浏览器中打开官方地址：\n{WEBVIEW2_DOWNLOAD_PAGE}"),
                    _ => format!("无法打开日志目录。\n\n按 Ctrl+C 复制此提示中的目录，再用文件资源管理器打开：\n{target}"),
                };
                let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
                let title: Vec<u16> = "Mizar 启动失败\0".encode_utf16().collect();
                unsafe {
                    MessageBoxW(0, message.as_ptr(), title.as_ptr(), 0x10);
                }
            }
            outcome
        },
        |stage, result, detail| log.event(stage, result, detail),
    )
}

pub fn failure_dialog(message: &str, logs: Option<&Path>) {
    let detail = match logs {
        Some(directory) => format!("Mizar 桌面界面启动失败。\n\n{message}\n\n诊断日志目录：{}\n\n是否打开日志目录？选择“否”退出。", directory.display()),
        None => format!("Mizar 桌面界面启动失败。\n\n{message}\n\n无法写入诊断日志。请检查安装目录和运行数据目录是否可写。"),
    };
    let detail: Vec<u16> = detail
        .chars()
        .take(4000)
        .filter(|c| *c != '\0')
        .collect::<String>()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let title: Vec<u16> = "Mizar 启动失败\0".encode_utf16().collect();
    let answer = unsafe {
        MessageBoxW(
            0,
            detail.as_ptr(),
            title.as_ptr(),
            0x10 | if logs.is_some() { 0x4 | 0x100 } else { 0 },
        )
    };
    if answer == 6 {
        if let Some(logs) = logs {
            let open: Vec<u16> = "open\0".encode_utf16().collect();
            let directory: Vec<u16> = logs
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            unsafe {
                ShellExecuteW(
                    0,
                    open.as_ptr(),
                    directory.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                );
            }
        }
    }
}

pub fn windows_version() -> String {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(version: *mut Version) -> i32;
    }
    let mut version = Version {
        size: std::mem::size_of::<Version>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    if unsafe { RtlGetVersion(&mut version) } == 0 {
        format!("{}.{}.{}", version.major, version.minor, version.build)
    } else {
        "unknown".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };


    fn owned_child(job: &RuntimeJob) -> Child {
        let child = Command::new("cmd.exe")
            .args(["/D", "/Q", "/K"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        job.assign(&child).unwrap();
        child
    }
    #[test]
    fn closing_job_terminates_owned_process() {
        let job = RuntimeJob::new().unwrap();
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/Q", "/K"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        job.assign(&child).unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"rem job assignment complete\r\n")
            .unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(child.try_wait().unwrap().is_some());
    }





    #[test]
    fn termination_does_not_touch_a_borrowed_process() {
        let outside = RuntimeJob::new().unwrap();
        let mut borrowed = owned_child(&outside);
        let startup = RuntimeJob::new().unwrap();
        let mut owned = owned_child(&startup);
        startup.terminate().unwrap();
        owned.wait().unwrap();
        assert!(borrowed.try_wait().unwrap().is_none());
        drop(outside);
        borrowed.wait().unwrap();
    }
}

#[cfg(test)]
mod webview_recovery_tests {
    use super::*;


}
