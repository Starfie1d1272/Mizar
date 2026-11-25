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
    fn GetCurrentProcess() -> isize;
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
/// A one-shot acknowledgement to the updater which launched this Host.
/// Runtime readiness and the desktop event loop must both precede this signal.
pub fn acknowledge_update_start() -> io::Result<()> {
    let Ok(name) = std::env::var("MIZAR_UPDATE_READY_EVENT") else {
        return Ok(());
    };
    let Some(token) = name.strip_prefix("Local\\MizarUpdateStarted-") else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid update event",
        ));
    };
    if token.len() != 32 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid update event",
        ));
    }
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { OpenEventW(0x0002, 0, name.as_ptr()) };
    if handle == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { SetEvent(handle) };
    let error = io::Error::last_os_error();
    unsafe { CloseHandle(handle) };
    if result == 0 {
        Err(error)
    } else {
        Ok(())
    }
}

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

/// Owned process groups share explicit assignment and kill-on-close semantics.
/// The runtime wrapper waits for assignment before starting Companion.
pub struct RuntimeJob(isize);
impl RuntimeJob {
    pub fn new() -> io::Result<Self> {
        Self::create(std::ptr::null())
    }
    pub fn named(name: &str) -> io::Result<Self> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        Self::create(wide.as_ptr())
    }
    fn create(name: *const u16) -> io::Result<Self> {
        let job = Self(unsafe { CreateJobObjectW(std::ptr::null(), name) });
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
        self.terminate_with_code(1)
    }
    pub fn terminate_with_code(&self, code: u32) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, code) } == 0 {
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
    pub fn assign_current(&self) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0, GetCurrentProcess()) } == 0 {
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

impl DesktopMutex {
    pub fn raw_handle(&self) -> isize {
        self.0
    }
}

pub fn current_process_start_time() -> u64 {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetProcessTimes(
            process: isize,
            creation: *mut u64,
            exit: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }
    let mut creation = 0u64;
    let mut exit = 0u64;
    let mut kernel = 0u64;
    let mut user = 0u64;
    if unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } != 0
    {
        creation
    } else {
        0
    }
}

pub fn spawn_applier_with_inherited_mutex(
    exe: &Path,
    args: &[String],
    desktop_mutex: &DesktopMutex,
    log_file: &std::fs::File,
) -> io::Result<()> {
    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: isize,
        h_std_output: isize,
        h_std_error: isize,
    }
    #[repr(C)]
    struct StartupInfoExW {
        startup_info: StartupInfoW,
        lp_attribute_list: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        h_process: isize,
        h_thread: isize,
        dw_process_id: u32,
        dw_thread_id: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetHandleInformation(object: isize, mask: u32, flags: u32) -> i32;
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: u32,
            attribute: usize,
            value: *const c_void,
            size: usize,
            previous: *mut c_void,
            return_size: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(
            application_name: *const u16,
            command_line: *mut u16,
            process_attrs: *const c_void,
            thread_attrs: *const c_void,
            inherit_handles: i32,
            creation_flags: u32,
            environment: *const c_void,
            current_dir: *const u16,
            startup_info: *const StartupInfoExW,
            process_info: *mut ProcessInformation,
        ) -> i32;
    }

    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;

    let mutex_handle = desktop_mutex.raw_handle();
    let log_handle = log_file.as_raw_handle() as isize;
    unsafe {
        if SetHandleInformation(mutex_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
            return Err(io::Error::last_os_error());
        }
        if SetHandleInformation(log_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
            return Err(io::Error::last_os_error());
        }
    }

    let mut handles = [mutex_handle, log_handle];
    let mut size: usize = 0;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut attr_buf = vec![0u8; size];
    let attr_list = attr_buf.as_mut_ptr() as *mut c_void;
    if unsafe { InitializeProcThreadAttributeList(attr_list, 1, 0, &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let update_ok = unsafe {
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handles.as_mut_ptr() as *const c_void,
            std::mem::size_of_val(&handles),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if update_ok == 0 {
        let err = io::Error::last_os_error();
        unsafe { DeleteProcThreadAttributeList(attr_list) };
        return Err(err);
    }

    let mut cmdline = format!("\"{}\"", exe.display());
    for arg in args {
        cmdline.push(' ');
        if arg.contains([' ', '\t', '"']) {
            cmdline.push('"');
            for ch in arg.chars() {
                if ch == '"' {
                    cmdline.push_str("\\\"");
                } else {
                    cmdline.push(ch);
                }
            }
            cmdline.push('"');
        } else {
            cmdline.push_str(arg);
        }
    }
    let mut cmd_wide: Vec<u16> = cmdline.encode_utf16().chain(Some(0)).collect();
    let app_wide: Vec<u16> = exe
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let dir_wide: Option<Vec<u16>> = exe.parent().map(|p| {
        p.as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect()
    });

    let si = StartupInfoExW {
        startup_info: StartupInfoW {
            cb: std::mem::size_of::<StartupInfoExW>() as u32,
            lp_reserved: std::ptr::null_mut(),
            lp_desktop: std::ptr::null_mut(),
            lp_title: std::ptr::null_mut(),
            dw_x: 0,
            dw_y: 0,
            dw_x_size: 0,
            dw_y_size: 0,
            dw_x_count_chars: 0,
            dw_y_count_chars: 0,
            dw_fill_attribute: 0,
            dw_flags: STARTF_USESTDHANDLES,
            w_show_window: 0,
            cb_reserved2: 0,
            lp_reserved2: std::ptr::null_mut(),
            h_std_input: 0,
            h_std_output: log_handle,
            h_std_error: log_handle,
        },
        lp_attribute_list: attr_list,
    };
    let mut pi = ProcessInformation {
        h_process: 0,
        h_thread: 0,
        dw_process_id: 0,
        dw_thread_id: 0,
    };

    let ok = unsafe {
        CreateProcessW(
            app_wide.as_ptr(),
            cmd_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            std::ptr::null(),
            dir_wide.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            &si,
            &mut pi,
        )
    };
    let err = io::Error::last_os_error();
    unsafe { DeleteProcThreadAttributeList(attr_list) };
    if ok == 0 {
        return Err(err);
    }
    unsafe {
        CloseHandle(pi.h_thread);
        CloseHandle(pi.h_process);
    }
    Ok(())
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

pub fn set_window_app_user_model(hwnd: isize, bundle_root: &Path) {
    if !bundle_root.join("installed.flag").is_file() {
        return;
    }
    let install_dir = bundle_root
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "versions"))
        .and_then(Path::parent)
        .unwrap_or(bundle_root);
    let launcher = install_dir.join("Mizar.exe");

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[repr(C)]
    struct PropertyKey {
        fmtid: Guid,
        pid: u32,
    }
    #[repr(C)]
    struct PropVariantStr {
        vt: u16,
        reserved1: u16,
        reserved2: u16,
        reserved3: u16,
        pwsz_val: *const u16,
        pad: usize,
    }
    #[repr(C)]
    struct IPropertyStoreVtbl {
        query_interface: usize,
        add_ref: usize,
        release: unsafe extern "system" fn(*mut c_void) -> u32,
        get_count: usize,
        get_at: usize,
        get_value: usize,
        set_value: unsafe extern "system" fn(
            *mut c_void,
            *const PropertyKey,
            *const PropVariantStr,
        ) -> i32,
        commit: unsafe extern "system" fn(*mut c_void) -> i32,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetPropertyStoreForWindow(
            hwnd: isize,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> i32;
    }

    const IID_IPROPERTYSTORE: Guid = Guid {
        data1: 0x886d8eeb,
        data2: 0x8cf2,
        data3: 0x4446,
        data4: [0x8d, 0x02, 0xcd, 0xba, 0x1d, 0xbd, 0xcf, 0x99],
    };
    const AUMID_FMTID: Guid = Guid {
        data1: 0x9f4c2855,
        data2: 0x9f79,
        data3: 0x4b39,
        data4: [0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3],
    };
    const PKEY_APPUSERMODEL_ID: PropertyKey = PropertyKey {
        fmtid: AUMID_FMTID,
        pid: 5,
    };
    const PKEY_APPUSERMODEL_RELAUNCH_COMMAND: PropertyKey = PropertyKey {
        fmtid: AUMID_FMTID,
        pid: 2,
    };

    let mut store: *mut c_void = std::ptr::null_mut();
    if unsafe { SHGetPropertyStoreForWindow(hwnd, &IID_IPROPERTYSTORE, &mut store) } != 0
        || store.is_null()
    {
        return;
    }
    unsafe {
        let vtbl = &*(*(store as *const *const IPropertyStoreVtbl));
        let aumid: Vec<u16> = "Starfie1d1272.Mizar\0".encode_utf16().collect();
        let pv_id = PropVariantStr {
            vt: 31, // VT_LPWSTR
            reserved1: 0,
            reserved2: 0,
            reserved3: 0,
            pwsz_val: aumid.as_ptr(),
            pad: 0,
        };
        let _ = (vtbl.set_value)(store, &PKEY_APPUSERMODEL_ID, &pv_id);

        let relaunch: Vec<u16> = launcher
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let pv_relaunch = PropVariantStr {
            vt: 31,
            reserved1: 0,
            reserved2: 0,
            reserved3: 0,
            pwsz_val: relaunch.as_ptr(),
            pad: 0,
        };
        let _ = (vtbl.set_value)(store, &PKEY_APPUSERMODEL_RELAUNCH_COMMAND, &pv_relaunch);
        let _ = (vtbl.commit)(store);
        let _ = (vtbl.release)(store);
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
