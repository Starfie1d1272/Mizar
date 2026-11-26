use mizar_common::{
    normalize_for_compare, to_wide, DESKTOP_MUTEX, UPDATE_ACTIVE_EVENT, UPDATE_WRITER_MUTEX,
};
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> isize;
    fn ReleaseMutex(handle: isize) -> i32;
    fn CreateEventW(
        attributes: *mut c_void,
        manual_reset: i32,
        initial_state: i32,
        name: *const u16,
    ) -> isize;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn GetLastError() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn GetProcessTimes(
        process: isize,
        creation: *mut u64,
        exit: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        process: isize,
        flags: u32,
        exe_name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn GetCurrentProcessId() -> u32;
    fn GetTickCount64() -> u64;
    fn QueryPerformanceCounter(lp_performance_count: *mut i64) -> i32;
    fn GetSystemTime(lp_system_time: *mut SystemTime);
}

#[repr(C)]
#[derive(Default)]
struct SystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

pub fn utc_iso8601() -> String {
    let mut st = SystemTime::default();
    unsafe { GetSystemTime(&mut st) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        st.year, st.month, st.day, st.hour, st.minute, st.second
    )
}

pub fn utc_compact_timestamp() -> String {
    let mut st = SystemTime::default();
    unsafe { GetSystemTime(&mut st) };
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        st.year, st.month, st.day, st.hour, st.minute, st.second
    )
}

pub fn random_hex_16() -> String {
    let mut qpc: i64 = 0;
    unsafe { QueryPerformanceCounter(&mut qpc) };
    let tick = unsafe { GetTickCount64() };
    let pid = unsafe { GetCurrentProcessId() };
    let mut h = Sha256::new();
    h.update(qpc.to_le_bytes());
    h.update(tick.to_le_bytes());
    h.update(pid.to_le_bytes());
    let out = h.finalize();
    out.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

pub struct WriterMutex(isize);
impl WriterMutex {
    pub fn try_acquire() -> io::Result<Option<Self>> {
        let name = to_wide(UPDATE_WRITER_MUTEX);
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle == 0 {
            return Err(io::Error::last_os_error());
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == 0 || wait == 0x80 {
            Ok(Some(Self(handle)))
        } else {
            unsafe { CloseHandle(handle) };
            Ok(None)
        }
    }
}
impl Drop for WriterMutex {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }
}

pub struct UpdateActiveEvent(isize);
impl UpdateActiveEvent {
    pub fn acquire() -> io::Result<Self> {
        let name = to_wide(UPDATE_ACTIVE_EVENT);
        let handle = unsafe { CreateEventW(std::ptr::null_mut(), 1, 1, name.as_ptr()) };
        if handle == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for UpdateActiveEvent {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { CloseHandle(self.0) };
        }
    }
}

pub struct DesktopMutexHandle(isize);
impl DesktopMutexHandle {
    pub fn from_raw(raw: usize) -> Self {
        Self(raw as isize)
    }
    pub fn acquire_or_create() -> io::Result<Self> {
        let name = to_wide(DESKTOP_MUTEX);
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }
    pub fn release_now(&mut self) {
        if self.0 != 0 {
            unsafe { CloseHandle(self.0) };
            self.0 = 0;
        }
    }
}
impl Drop for DesktopMutexHandle {
    fn drop(&mut self) {
        self.release_now();
    }
}

pub enum HostExitOutcome {
    Exited,
    Cancelled,
}

pub fn wait_host_exit(
    pid: u32,
    expected_start_time: u64,
    timeout: Duration,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<HostExitOutcome, String> {
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle == 0 {
        let err = unsafe { GetLastError() };
        if err == 87 {
            // ERROR_INVALID_PARAMETER: process already exited
            return Ok(HostExitOutcome::Exited);
        }
        return Err(format!("无法打开宿主进程 {pid} (os={err})"));
    }
    let mut creation = 0u64;
    let mut exit = 0u64;
    let mut kernel = 0u64;
    let mut user = 0u64;
    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    if ok != 0 && expected_start_time != 0 && creation != expected_start_time {
        unsafe { CloseHandle(handle) };
        return Ok(HostExitOutcome::Exited);
    }

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        if is_cancelled() {
            break Ok(HostExitOutcome::Cancelled);
        }
        let wait = unsafe { WaitForSingleObject(handle, 100) };
        if wait == 0 {
            break Ok(HostExitOutcome::Exited);
        }
        if is_cancelled() {
            break Ok(HostExitOutcome::Cancelled);
        }
        if Instant::now() >= deadline {
            break Err(format!("等待旧版 Mizar (PID {pid}) 退出超时"));
        }
    };
    unsafe { CloseHandle(handle) };
    outcome
}

pub fn find_running_mizar_under(install_dir: &Path) -> bool {
    use windows::Win32::Foundation::CloseHandle as WinClose;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let norm_install = format!("{}\\", normalize_for_compare(install_dir));
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return false;
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = false;
    if unsafe { Process32FirstW(snap, &mut entry) }.is_ok() {
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if name.eq_ignore_ascii_case("Mizar.exe") {
                let proc_handle = unsafe { OpenProcess(0x1000, 0, entry.th32ProcessID) };
                if proc_handle != 0 {
                    let mut buf = vec![0u16; 1024];
                    let mut size = buf.len() as u32;
                    let ok = unsafe {
                        QueryFullProcessImageNameW(proc_handle, 0, buf.as_mut_ptr(), &mut size)
                    };
                    unsafe { CloseHandle(proc_handle) };
                    if ok != 0 {
                        let exe_path =
                            String::from_utf16_lossy(&buf[..size as usize]).to_ascii_lowercase();
                        if exe_path.starts_with(&norm_install) {
                            found = true;
                            break;
                        }
                    }
                }
            }
            if unsafe { Process32NextW(snap, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { WinClose(snap) };
    found
}

pub enum LaunchOutcome {
    Ready,
    ExitedEarly(Option<i32>),
    Timeout,
}

pub fn launch_and_wait_ready(exe_path: &Path, timeout: Duration) -> io::Result<LaunchOutcome> {
    let nonce = random_hex_16();
    let event_name = format!("Local\\MizarUpdateStarted-{nonce}");
    let wide = to_wide(&event_name);
    let event = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, wide.as_ptr()) };
    if event == 0 {
        return Err(io::Error::last_os_error());
    }
    let child_res = Command::new(exe_path)
        .env("MIZAR_UPDATE_READY_EVENT", &event_name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child_res {
        Ok(c) => c,
        Err(e) => {
            unsafe { CloseHandle(event) };
            return Err(e);
        }
    };
    let deadline = Instant::now() + timeout;
    let outcome = loop {
        if unsafe { WaitForSingleObject(event, 0) } == 0 {
            break Ok(LaunchOutcome::Ready);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(LaunchOutcome::ExitedEarly(status.code())),
            Ok(None) => (),
            Err(e) => break Err(e),
        }
        if Instant::now() >= deadline {
            break Ok(LaunchOutcome::Timeout);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    unsafe { CloseHandle(event) };
    outcome
}

pub fn write_install_registry(
    install_dir: &Path,
    state_root: &Path,
    version: &str,
) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn set_sz(key: HKEY, name: &str, val: &str) -> Result<(), String> {
        let name_w = to_wide(name);
        let val_w = to_wide(val);
        let bytes =
            unsafe { std::slice::from_raw_parts(val_w.as_ptr() as *const u8, val_w.len() * 2) };
        let status =
            unsafe { RegSetValueExW(key, PCWSTR(name_w.as_ptr()), Some(0), REG_SZ, Some(bytes)) };
        if status.0 != 0 {
            return Err(format!("写入注册表 {name} 失败: {}", status.0));
        }
        Ok(())
    }

    fn set_dword(key: HKEY, name: &str, val: u32) -> Result<(), String> {
        let name_w = to_wide(name);
        let bytes = val.to_le_bytes();
        let status = unsafe {
            RegSetValueExW(
                key,
                PCWSTR(name_w.as_ptr()),
                Some(0),
                REG_DWORD,
                Some(&bytes),
            )
        };
        if status.0 != 0 {
            return Err(format!("写入注册表 {name} 失败: {}", status.0));
        }
        Ok(())
    }

    let subkey = to_wide("Software\\Mizar");
    let mut key = HKEY::default();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        )
    };
    if status.0 != 0 {
        return Err(format!("创建 HKCU\\Software\\Mizar 失败: {}", status.0));
    }
    let res = (|| {
        set_sz(key, "InstallDir", &install_dir.to_string_lossy())?;
        set_sz(key, "StateRoot", &state_root.to_string_lossy())
    })();
    unsafe {
        let _ = RegCloseKey(key);
    };
    res?;

    let uninst_subkey = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar");
    let mut ukey = HKEY::default();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(uninst_subkey.as_ptr()),
            Some(0),
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut ukey,
            None,
        )
    };
    if status.0 != 0 {
        return Err(format!("创建 Uninstall 注册表项失败: {}", status.0));
    }
    let mizar_exe = install_dir.join("Mizar.exe").to_string_lossy().into_owned();
    let uninst_exe = format!(
        "\"{}\"",
        install_dir.join("Uninstall.exe").to_string_lossy()
    );
    let res = (|| {
        set_sz(ukey, "DisplayName", "Mizar")?;
        set_sz(ukey, "DisplayVersion", version)?;
        set_sz(ukey, "UninstallString", &uninst_exe)?;
        set_sz(ukey, "DisplayIcon", &mizar_exe)?;
        set_sz(ukey, "Publisher", "Starfie1d1272")?;
        set_sz(ukey, "InstallLocation", &install_dir.to_string_lossy())?;
        set_dword(ukey, "NoModify", 1)?;
        set_dword(ukey, "NoRepair", 1)
    })();
    unsafe {
        let _ = RegCloseKey(ukey);
    };
    res
}

pub fn delete_install_registry() {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
    for sub in [
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar",
        "Software\\Mizar",
    ] {
        let w = to_wide(sub);
        unsafe {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(w.as_ptr()));
        }
    }
}

pub fn clear_legacy_run_once() {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };
    let sub = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce");
    let val = to_wide("!MizarUpdateRecovery");
    let mut key = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if status.0 == 0 {
        unsafe {
            let _ = RegDeleteValueW(key, PCWSTR(val.as_ptr()));
            let _ = RegCloseKey(key);
        }
    }
}

fn known_folder(csidl: i32) -> Option<PathBuf> {
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetFolderPathW(
            hwnd: isize,
            csidl: i32,
            token: isize,
            flags: u32,
            path: *mut u16,
        ) -> i32;
    }
    let mut buf = vec![0u16; 260];
    let hr = unsafe { SHGetFolderPathW(0, csidl, 0, 0, buf.as_mut_ptr()) };
    if hr != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

pub fn start_menu_dir() -> Option<PathBuf> {
    known_folder(0x0002).map(|p| p.join("Mizar"))
}

pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(0x0010)
}

pub fn create_shortcut(lnk_path: &Path, target: &Path, workdir: &Path) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    if let Some(parent) = lnk_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建快捷方式目录失败: {e}"))?;
    }
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if init.is_err() && init != RPC_E_CHANGED_MODE {
            return Err(format!("CoInitializeEx 失败: {init:?}"));
        }
        let need_uninit = init.is_ok();
        let res = (|| -> Result<(), String> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("创建 ShellLink 失败: {e:?}"))?;
            let target_w = to_wide(&target.to_string_lossy());
            let dir_w = to_wide(&workdir.to_string_lossy());
            let lnk_w = to_wide(&lnk_path.to_string_lossy());
            link.SetPath(PCWSTR(target_w.as_ptr()))
                .map_err(|e| format!("SetPath 失败: {e:?}"))?;
            link.SetWorkingDirectory(PCWSTR(dir_w.as_ptr()))
                .map_err(|e| format!("SetWorkingDirectory 失败: {e:?}"))?;
            link.SetIconLocation(PCWSTR(target_w.as_ptr()), 0)
                .map_err(|e| format!("SetIconLocation 失败: {e:?}"))?;
            let persist: IPersistFile = link
                .cast()
                .map_err(|e| format!("IPersistFile 转换失败: {e:?}"))?;
            persist
                .Save(PCWSTR(lnk_w.as_ptr()), true)
                .map_err(|e| format!("保存快捷方式失败: {e:?}"))?;
            Ok(())
        })();
        if need_uninit {
            CoUninitialize();
        }
        res
    }
}

pub fn remove_shortcuts() {
    if let Some(desktop) = desktop_dir() {
        let _ = fs::remove_file(desktop.join("Mizar.lnk"));
    }
    if let Some(sm) = start_menu_dir() {
        let _ = fs::remove_file(sm.join("Mizar.lnk"));
        let _ = fs::remove_file(sm.join("卸载 Mizar.lnk"));
        let _ = fs::remove_dir(&sm);
    }
}

pub fn show_message_box(title: &str, text: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    let title_w = to_wide(title);
    let text_w = to_wide(text);
    unsafe {
        MessageBoxW(0, text_w.as_ptr(), title_w.as_ptr(), 0x30);
    }
}

pub fn schedule_dir_delete(dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let cmd = format!(
        "ping -n 2 127.0.0.1 >nul & rmdir /s /q \"{}\"",
        dir.display()
    );
    let _ = Command::new("cmd.exe")
        .args(["/C", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

pub fn schedule_self_delete(exe_path: &Path, install_dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let cmd = format!(
        "ping -n 2 127.0.0.1 >nul & del /f /q \"{}\" & rmdir \"{}\"",
        exe_path.display(),
        install_dir.display()
    );
    let _ = Command::new("cmd.exe")
        .args(["/C", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
