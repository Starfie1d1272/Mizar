//! Restore peers only on an outside -> workspace activation. Never activate,
//! reposition, resize, reparent, close, or make a member topmost.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Members {
    pub left: isize,
    pub dock: isize,
    pub game: isize,
    pub created: u64,
}
impl Members {
    fn handles(self) -> [isize; 3] {
        [self.left, self.dock, self.game]
    }
    fn role(self, hwnd: isize) -> &'static str {
        if hwnd == self.left {
            "left"
        } else if hwnd == self.dock {
            "dock"
        } else {
            "game"
        }
    }
    fn contains(self, hwnd: isize) -> bool {
        hwnd != 0 && self.handles().contains(&hwnd)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operation {
    Complete,
    Skipped,
    Failed(u32),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub stage: &'static str,
    pub api: &'static str,
    pub last_error: Option<u32>,
    pub target: &'static str,
}
impl Failure {
    pub fn diagnostic(self) -> serde_json::Value {
        serde_json::json!({"stage": self.stage, "api": self.api, "lastError": self.last_error, "target": self.target})
    }
    pub fn message(self) -> String {
        let target = match self.target {
            "left" => "工作台左侧",
            "dock" => "工作台底栏",
            "game" => "CS2",
            _ => "工作台窗口组",
        };
        if self.last_error == Some(5) {
            format!("{target}窗口层级恢复被系统拒绝。请核对 Mizar 与 Steam／CS2 的运行权限，切回工作台重试；仍失败时正常退出本次游戏，在准备中心重试恢复，备份与错误记录会保留。")
        } else {
            format!("{target}窗口层级恢复未完成。请还原窗口并切回工作台重试；仍失败时正常退出本次游戏，在准备中心重试恢复，备份与错误记录会保留。")
        }
    }
}

trait Windows {
    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }
    fn foreground(&self) -> isize;
    fn ready(&self, hwnd: isize) -> bool;
    fn minimized(&self, hwnd: isize) -> bool;
    fn restore(&mut self, hwnd: isize) -> Operation;
    fn raise_behind(&mut self, hwnd: isize, selected: isize) -> Operation;
}

#[derive(Default)]
pub struct Group {
    members: Option<Members>,
    inside: bool,
    last_foreground: isize,
    // One transaction and a monotonic deadline, independent of worker delays.
    pending: Option<(isize, std::time::Instant, bool)>,
    pub restored: bool,
}
impl Group {
    fn tick(&mut self, windows: &mut impl Windows, members: Option<Members>) -> Option<Failure> {
        self.restored = false;
        let selected = windows.foreground();
        if self.members != members {
            self.members = members;
            self.inside = members.is_some_and(|m| m.contains(self.last_foreground));
            self.pending = None;
        }
        self.last_foreground = selected;
        let Some(members) = members else {
            return None;
        };
        let inside = members.contains(selected);
        if !inside {
            self.inside = false;
            self.pending = None;
            return None;
        }
        if !self.inside {
            self.pending = Some((
                selected,
                windows.now() + std::time::Duration::from_secs(2),
                false,
            ));
        }
        self.inside = true;
        let (expected, deadline, submitted) = self.pending.take()?;
        // User cancellation, hide, exit, modal and topmost windows are skips,
        // not errors. Consuming pending ensures at most one failure per entry.
        if expected != selected || !members.handles().into_iter().all(|h| windows.ready(h)) {
            return None;
        }
        if windows.now() >= deadline {
            return Some(Failure {
                stage: "restore_timeout",
                api: "ShowWindowAsync",
                last_error: None,
                target: "group",
            });
        }
        let mut waiting = false;
        for hwnd in members.handles().into_iter().filter(|h| *h != selected) {
            if windows.foreground() != expected {
                return None;
            }
            if windows.minimized(hwnd) {
                if !submitted {
                    match windows.restore(hwnd) {
                        Operation::Complete => (),
                        Operation::Skipped => return None,
                        Operation::Failed(code) => {
                            return Some(Failure {
                                stage: "restore",
                                api: "ShowWindowAsync",
                                last_error: Some(code),
                                target: members.role(hwnd),
                            })
                        }
                    }
                }
                waiting = true;
            }
        }
        if waiting {
            self.pending = Some((expected, deadline, true));
            return None;
        }
        for hwnd in members.handles().into_iter().filter(|h| *h != selected) {
            if windows.foreground() != expected {
                return None;
            }
            match windows.raise_behind(hwnd, expected) {
                Operation::Complete => (),
                Operation::Skipped => return None,
                Operation::Failed(code) => {
                    return Some(Failure {
                        stage: "raise",
                        api: "SetWindowPos",
                        last_error: Some(code),
                        target: members.role(hwnd),
                    })
                }
            }
        }
        self.restored = true;
        None
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::managed_cs2::WorkspaceProcess;

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(
            callback: unsafe extern "system" fn(isize, isize) -> i32,
            data: isize,
        ) -> i32;
        fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsWindowEnabled(hwnd: isize) -> i32;
        fn IsIconic(hwnd: isize) -> i32;
        fn GetWindow(hwnd: isize, command: u32) -> isize;
        fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
        fn GetForegroundWindow() -> isize;
        fn ShowWindowAsync(hwnd: isize, command: i32) -> i32;
        fn SetWindowPos(
            hwnd: isize,
            after: isize,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            flags: u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
        fn SetLastError(code: u32);
    }
    fn window_pid(hwnd: isize) -> u32 {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
        }
        pid
    }
    fn game_window(hwnd: isize, pid: u32) -> bool {
        unsafe {
            window_pid(hwnd) == pid && IsWindowVisible(hwnd) != 0
                && GetWindow(hwnd, 4) == 0 // GW_OWNER: ignore game dialogs
                && GetWindowLongW(hwnd, -16) & 0x4000_0000 == 0 // WS_CHILD
                && GetWindowLongW(hwnd, -20) & 0x80 == 0 // WS_EX_TOOLWINDOW
        }
    }
    struct Search {
        pid: u32,
        windows: Vec<isize>,
    }
    unsafe extern "system" fn collect(hwnd: isize, data: isize) -> i32 {
        let search = &mut *(data as *mut Search);
        if game_window(hwnd, search.pid) {
            search.windows.push(hwnd);
        }
        1
    }
    pub fn find_game(process: &WorkspaceProcess) -> Option<isize> {
        if !process.is_running() {
            return None;
        }
        let mut search = Search {
            pid: process.pid,
            windows: Vec::new(),
        };
        unsafe {
            EnumWindows(collect, &mut search as *mut _ as isize);
        }
        // Include minimized windows, but never guess between game and other
        // unowned windows of the same process.
        (search.windows.len() == 1).then(|| search.windows[0])
    }

    struct NativeWindows<'a> {
        process: &'a WorkspaceProcess,
        members: Members,
        allowed: &'a dyn Fn() -> bool,
    }
    fn raise_without_activation(hwnd: isize, selected: isize) -> Operation {
        // NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER | ASYNCWINDOWPOS.
        // The caller validates a non-topmost anchor; no TOPMOST toggle is used.
        unsafe {
            SetLastError(0);
            if SetWindowPos(hwnd, selected, 0, 0, 0, 0, 0x4213) != 0 {
                Operation::Complete
            } else {
                Operation::Failed(GetLastError())
            }
        }
    }
    impl Windows for NativeWindows<'_> {
        fn foreground(&self) -> isize {
            if (self.allowed)() {
                unsafe { GetForegroundWindow() }
            } else {
                0
            }
        }
        fn ready(&self, hwnd: isize) -> bool {
            let expected_pid = if hwnd == self.members.game {
                self.process.pid
            } else {
                std::process::id()
            };
            unsafe {
                (self.allowed)() && self.process.is_running() && window_pid(hwnd) == expected_pid
                    && IsWindowVisible(hwnd) != 0 && IsWindowEnabled(hwnd) != 0
                    // Inserting after a topmost anchor can promote peers. Leave
                    // exclusive fullscreen/topmost and modal windows alone.
                    && GetWindowLongW(hwnd, -20) & 0x8 == 0
                    && GetWindow(hwnd, 4) == 0
            }
        }
        fn minimized(&self, hwnd: isize) -> bool {
            unsafe { IsIconic(hwnd) != 0 }
        }
        fn restore(&mut self, hwnd: isize) -> Operation {
            if !self.ready(hwnd) {
                return Operation::Skipped;
            }
            unsafe {
                // Clear stale thread errors: ShowWindowAsync may fail without
                // setting an extended error. Zero is recorded as unavailable.
                SetLastError(0);
                if ShowWindowAsync(hwnd, 4) != 0 {
                    Operation::Complete
                }
                // SW_SHOWNOACTIVATE
                else {
                    Operation::Failed(GetLastError())
                }
            }
        }
        fn raise_behind(&mut self, hwnd: isize, selected: isize) -> Operation {
            if !self.ready(hwnd) || !self.ready(selected) || self.foreground() != selected {
                return Operation::Skipped;
            }
            raise_without_activation(hwnd, selected)
        }
    }
    pub fn synchronize(
        group: &mut Group,
        process: Option<&WorkspaceProcess>,
        panels: Option<[isize; 2]>,
        allowed: &dyn Fn() -> bool,
    ) -> Option<Failure> {
        group.restored = false;
        let members = process.zip(panels).and_then(|(process, panels)| {
            find_game(process).map(|game| Members {
                left: panels[0],
                dock: panels[1],
                game,
                created: process.created,
            })
        });
        if let (Some(process), Some(members)) = (process, members) {
            group.tick(
                &mut NativeWindows {
                    process,
                    members,
                    allowed,
                },
                Some(members),
            )
        } else {
            group.members = None;
            group.inside = false;
            group.pending = None;
            group.last_foreground = unsafe { GetForegroundWindow() };
            None
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
        };
        #[repr(C)]
        #[derive(Default)]
        struct WinRect {
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
        }
        #[repr(C)]
        #[derive(Default)]
        struct FileTime {
            low: u32,
            high: u32,
        }
        impl FileTime {
            fn value(&self) -> u64 {
                (self.high as u64) << 32 | self.low as u64
            }
        }
        fn until(condition: impl Fn() -> bool) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                // ShowWindowAsync queues an event even to this test's thread.
                // Process the real queue, then assert the requested state.
                unsafe {
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                if condition() {
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "native window event did not complete"
                );
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        #[link(name = "user32")]
        extern "system" {
            fn CreateWindowExW(
                ex: u32,
                class: *const u16,
                title: *const u16,
                style: u32,
                x: i32,
                y: i32,
                w: i32,
                h: i32,
                parent: isize,
                menu: isize,
                instance: isize,
                param: *const std::ffi::c_void,
            ) -> isize;
            fn DestroyWindow(hwnd: isize) -> i32;
            fn GetWindowRect(hwnd: isize, rect: *mut WinRect) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> isize;
            fn GetProcessTimes(
                process: isize,
                created: *mut FileTime,
                exit: *mut FileTime,
                kernel: *mut FileTime,
                user: *mut FileTime,
            ) -> i32;
        }
        struct Window(isize);
        impl Drop for Window {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        fn window(x: i32) -> Window {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0x00cf0000,
                    x,
                    -10000,
                    320,
                    240,
                    0,
                    0,
                    0,
                    std::ptr::null(),
                )
            };
            assert_ne!(hwnd, 0);
            assert_ne!(unsafe { ShowWindowAsync(hwnd, 4) }, 0);
            until(|| unsafe { IsWindowVisible(hwnd) != 0 });
            Window(hwnd)
        }
        fn rect(hwnd: isize) -> [i32; 4] {
            let mut rect = WinRect::default();
            assert_ne!(unsafe { GetWindowRect(hwnd, &mut rect) }, 0);
            [rect.left, rect.top, rect.right, rect.bottom]
        }
    }
}
#[cfg(windows)]
pub use native::synchronize;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    const MEMBERS: Members = Members {
        left: 1,
        dock: 2,
        game: 3,
        created: 10,
    };
    #[derive(Default)]
    struct Desktop {
        foreground: isize,
        unavailable: BTreeSet<isize>,
        minimized: BTreeSet<isize>,
        restores: Vec<isize>,
        raises: Vec<(isize, isize)>,
        reject_restore: bool,
        reject_raise: bool,
        skip_operations: bool,
        now: Option<std::time::Instant>,
        switch_after_raise: bool,
    }
    impl Windows for Desktop {
        fn now(&self) -> std::time::Instant {
            self.now.unwrap_or_else(std::time::Instant::now)
        }
        fn foreground(&self) -> isize {
            self.foreground
        }
        fn ready(&self, hwnd: isize) -> bool {
            !self.unavailable.contains(&hwnd)
        }
        fn minimized(&self, hwnd: isize) -> bool {
            self.minimized.contains(&hwnd)
        }
        fn restore(&mut self, hwnd: isize) -> Operation {
            if self.skip_operations {
                return Operation::Skipped;
            }
            self.restores.push(hwnd);
            if self.reject_restore {
                Operation::Failed(5)
            } else {
                Operation::Complete
            }
        }
        fn raise_behind(&mut self, hwnd: isize, selected: isize) -> Operation {
            if self.skip_operations {
                return Operation::Skipped;
            }
            self.raises.push((hwnd, selected));
            if self.switch_after_raise {
                self.foreground = 99;
            }
            if self.reject_raise {
                Operation::Failed(87)
            } else {
                Operation::Complete
            }
        }
    }

    #[test]
    fn hide_exit_or_lost_identity_disarms_and_replaced_game_is_not_targeted() {
        let mut group = Group::default();
        let mut desktop = Desktop {
            foreground: 1,
            minimized: [3].into(),
            ..Default::default()
        };
        let _ = group.tick(&mut desktop, Some(MEMBERS));
        let _ = group.tick(&mut desktop, None);
        desktop.minimized.clear();
        desktop.foreground = 3;
        let replacement = Members {
            game: 4,
            created: 20,
            ..MEMBERS
        };
        let _ = group.tick(&mut desktop, Some(replacement));
        assert!(desktop.raises.is_empty());
        desktop.foreground = 4;
        let _ = group.tick(&mut desktop, Some(replacement));
        assert_eq!(desktop.raises, [(1, 4), (2, 4)]);
    }
}
