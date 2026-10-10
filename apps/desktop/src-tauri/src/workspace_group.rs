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
    fn contains(self, hwnd: isize) -> bool {
        hwnd != 0 && self.handles().contains(&hwnd)
    }
}

trait Windows {
    fn foreground(&self) -> isize;
    fn ready(&self, hwnd: isize) -> bool;
    fn minimized(&self, hwnd: isize) -> bool;
    fn restore(&mut self, hwnd: isize) -> bool;
    fn raise_behind(&mut self, hwnd: isize, selected: isize) -> bool;
}

#[derive(Default)]
pub struct Group {
    members: Option<Members>,
    inside: bool,
    last_foreground: isize,
    // One bounded transaction; a rejected call is not retried each tick.
    pending: Option<(isize, u8)>,
}
impl Group {
    fn tick(&mut self, windows: &mut impl Windows, members: Option<Members>) {
        let selected = windows.foreground();
        if self.members != members {
            self.members = members;
            // Identity becoming available is not itself a user activation.
            self.inside = members.is_some_and(|m| m.contains(self.last_foreground));
            self.pending = None;
        }
        self.last_foreground = selected;
        let Some(members) = members else {
            return;
        };
        let inside = members.contains(selected);
        if !inside {
            self.inside = false;
            self.pending = None;
            return;
        }
        if !self.inside {
            self.pending = Some((selected, 8)); // <= 2s on the existing 250ms worker
        }
        self.inside = true;
        let Some((expected, remaining)) = self.pending else {
            return;
        };
        // Do not move peers behind a different member after the user changes
        // focus, or behind a disabled owner while a modal dialog is open.
        if expected != selected || !members.handles().into_iter().all(|h| windows.ready(h)) {
            self.pending = None;
            return;
        }
        self.pending = None;
        let mut waiting = false;
        for hwnd in members.handles().into_iter().filter(|h| *h != selected) {
            if windows.foreground() != expected {
                return;
            }
            if windows.minimized(hwnd) {
                // Submit each restore once, then only observe its completion.
                if remaining == 8 && !windows.restore(hwnd) {
                    return;
                }
                waiting = true;
            }
        }
        if waiting {
            if remaining > 1 {
                self.pending = Some((expected, remaining - 1));
            }
            return;
        }
        for hwnd in members.handles().into_iter().filter(|h| *h != selected) {
            if windows.foreground() != expected || !windows.raise_behind(hwnd, expected) {
                return;
            }
        }
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
    fn raise_without_activation(hwnd: isize, selected: isize) -> bool {
        // NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER | ASYNCWINDOWPOS.
        // The caller validates a non-topmost anchor; no TOPMOST toggle is used.
        unsafe { SetWindowPos(hwnd, selected, 0, 0, 0, 0, 0x4213) != 0 }
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
        fn restore(&mut self, hwnd: isize) -> bool {
            self.ready(hwnd) && unsafe { ShowWindowAsync(hwnd, 4) != 0 } // SW_SHOWNOACTIVATE
        }
        fn raise_behind(&mut self, hwnd: isize, selected: isize) -> bool {
            self.ready(hwnd)
                && self.ready(selected)
                && self.foreground() == selected
                && raise_without_activation(hwnd, selected)
        }
    }
    pub fn synchronize(
        group: &mut Group,
        process: Option<&WorkspaceProcess>,
        panels: Option<[isize; 2]>,
        allowed: &dyn Fn() -> bool,
    ) {
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
            );
        } else {
            group.members = None;
            group.inside = false;
            group.pending = None;
            group.last_foreground = unsafe { GetForegroundWindow() };
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
        #[test]
        fn native_restore_preserves_geometry_focus_and_normal_z_band() {
            let root =
                std::env::temp_dir().join(format!("mizar-group-native-{}", std::process::id()));
            let log = crate::startup_log::DesktopLog::new(&root, None).unwrap();
            let (mut created, mut exit, mut kernel, mut user) = (
                FileTime::default(),
                FileTime::default(),
                FileTime::default(),
                FileTime::default(),
            );
            assert_ne!(
                unsafe {
                    GetProcessTimes(
                        GetCurrentProcess(),
                        &mut created,
                        &mut exit,
                        &mut kernel,
                        &mut user,
                    )
                },
                0
            );
            let created = created.value();
            crate::cs2_session::SessionStore::new(log.state_root.clone())
                .save(&serde_json::json!({
                    "version": 1, "pid": std::process::id(), "created": created,
                    "executable": std::env::current_exe().unwrap()
                }))
                .unwrap();
            let process = crate::managed_cs2::ManagedCs2::new(log)
                .workspace_process()
                .unwrap()
                .unwrap();
            let left = window(-10000);
            let dock = window(-10500);
            let game = window(-11000);
            let members = Members {
                left: left.0,
                dock: dock.0,
                game: game.0,
                created,
            };
            let mut native = NativeWindows {
                process: &process,
                members,
                allowed: &|| true,
            };
            let before = rect(game.0);
            let foreground = unsafe { GetForegroundWindow() };
            assert!(native.ready(game.0));
            assert_ne!(unsafe { ShowWindowAsync(game.0, 7) }, 0); // minimize without activation
            until(|| native.minimized(game.0));
            assert!(native.minimized(game.0));
            let mut tracker = crate::windows_host::GameTracker::default();
            let tracked = crate::windows_host::Cs2Window {
                pid: process.pid,
                hwnd: game.0,
            };
            tracker.observe(Some(tracked));
            let generation = tracker.generation;
            assert!(tracker.tick().is_none());
            assert_eq!(tracker.window, Some(tracked));
            assert_eq!(tracker.generation, generation);
            assert!(game_window(game.0, process.pid)); // minimized is still discoverable
            assert!(!game_window(game.0, process.pid.wrapping_add(1)));
            assert!(native.restore(game.0));
            until(|| !native.minimized(game.0));
            assert!(!native.minimized(game.0));
            assert_eq!(rect(game.0), before);
            assert!(raise_without_activation(game.0, left.0));
            assert_eq!(rect(game.0), before);
            assert_eq!(unsafe { GetForegroundWindow() }, foreground);
            assert_eq!(unsafe { GetWindowLongW(game.0, -20) } & 0x8, 0);
            let dead = window(-11500);
            let hwnd = dead.0;
            drop(dead);
            assert!(!native.ready(hwnd));
            assert!(!native.restore(hwnd));
            drop(process);
            std::fs::remove_dir_all(root).unwrap();
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
        switch_after_raise: bool,
    }
    impl Windows for Desktop {
        fn foreground(&self) -> isize {
            self.foreground
        }
        fn ready(&self, hwnd: isize) -> bool {
            !self.unavailable.contains(&hwnd)
        }
        fn minimized(&self, hwnd: isize) -> bool {
            self.minimized.contains(&hwnd)
        }
        fn restore(&mut self, hwnd: isize) -> bool {
            self.restores.push(hwnd);
            !self.reject_restore
        }
        fn raise_behind(&mut self, hwnd: isize, selected: isize) -> bool {
            self.raises.push((hwnd, selected));
            if self.switch_after_raise {
                self.foreground = 99;
            }
            true
        }
    }
    #[test]
    fn entering_each_member_once_preserves_selected_focus() {
        for selected in [1, 2, 3] {
            let mut group = Group::default();
            let mut desktop = Desktop {
                foreground: 99,
                ..Default::default()
            };
            group.tick(&mut desktop, Some(MEMBERS));
            desktop.foreground = selected;
            group.tick(&mut desktop, Some(MEMBERS));
            assert_eq!(desktop.foreground, selected);
            assert_eq!(desktop.raises.len(), 2);
            assert!(desktop
                .raises
                .iter()
                .all(|(peer, anchor)| *peer != selected && *anchor == selected));
            group.tick(&mut desktop, Some(MEMBERS));
            desktop.foreground = if selected == 1 { 2 } else { 1 };
            group.tick(&mut desktop, Some(MEMBERS));
            assert_eq!(desktop.raises.len(), 2);
            desktop.foreground = 99;
            group.tick(&mut desktop, Some(MEMBERS));
            desktop.foreground = selected;
            group.tick(&mut desktop, Some(MEMBERS));
            assert_eq!(desktop.raises.len(), 4);
        }
    }
    #[test]
    fn minimized_peers_restore_once_and_raise_after_completion() {
        let mut group = Group::default();
        let mut desktop = Desktop {
            foreground: 1,
            minimized: [2, 3].into(),
            ..Default::default()
        };
        group.tick(&mut desktop, Some(MEMBERS));
        group.tick(&mut desktop, Some(MEMBERS));
        assert_eq!(desktop.restores, [2, 3]);
        assert!(desktop.raises.is_empty());
        desktop.minimized.clear();
        group.tick(&mut desktop, Some(MEMBERS));
        assert_eq!(desktop.raises, [(2, 1), (3, 1)]);
    }
    #[test]
    fn blocked_or_rejected_restore_does_not_loop() {
        for rejected in [false, true] {
            let mut group = Group::default();
            let mut desktop = Desktop {
                foreground: 1,
                minimized: [3].into(),
                reject_restore: rejected,
                ..Default::default()
            };
            for _ in 0..20 {
                group.tick(&mut desktop, Some(MEMBERS));
            }
            desktop.minimized.clear();
            group.tick(&mut desktop, Some(MEMBERS));
            assert_eq!(desktop.restores, [3]);
            assert!(desktop.raises.is_empty());
        }
    }
    #[test]
    fn hidden_disabled_invalid_or_topmost_member_blocks_the_transaction() {
        let mut group = Group::default();
        let mut desktop = Desktop {
            foreground: 1,
            unavailable: [3].into(),
            ..Default::default()
        };
        group.tick(&mut desktop, Some(MEMBERS));
        desktop.unavailable.clear();
        group.tick(&mut desktop, Some(MEMBERS));
        assert!(desktop.restores.is_empty());
        assert!(desktop.raises.is_empty());
    }
    #[test]
    fn switching_away_or_between_members_cancels_pending_restore() {
        for next in [99, 2] {
            let mut group = Group::default();
            let mut desktop = Desktop {
                foreground: 1,
                minimized: [3].into(),
                ..Default::default()
            };
            group.tick(&mut desktop, Some(MEMBERS));
            desktop.foreground = next;
            desktop.minimized.clear();
            group.tick(&mut desktop, Some(MEMBERS));
            assert!(desktop.raises.is_empty());
        }
    }
    #[test]
    fn leaving_during_raise_stops_remaining_operations() {
        let mut group = Group::default();
        let mut desktop = Desktop {
            foreground: 3,
            switch_after_raise: true,
            ..Default::default()
        };
        group.tick(&mut desktop, Some(MEMBERS));
        assert_eq!(desktop.raises, [(1, 3)]);
        assert_eq!(desktop.foreground, 99);
    }
    #[test]
    fn hide_exit_or_lost_identity_disarms_and_replaced_game_is_not_targeted() {
        let mut group = Group::default();
        let mut desktop = Desktop {
            foreground: 1,
            minimized: [3].into(),
            ..Default::default()
        };
        group.tick(&mut desktop, Some(MEMBERS));
        group.tick(&mut desktop, None);
        desktop.minimized.clear();
        desktop.foreground = 3;
        let replacement = Members {
            game: 4,
            created: 20,
            ..MEMBERS
        };
        group.tick(&mut desktop, Some(replacement));
        assert!(desktop.raises.is_empty());
        desktop.foreground = 4;
        group.tick(&mut desktop, Some(replacement));
        assert_eq!(desktop.raises, [(1, 4), (2, 4)]);
    }
    #[test]
    fn identity_recovery_without_new_activation_does_not_raise_again() {
        let mut group = Group::default();
        let mut desktop = Desktop {
            foreground: 1,
            ..Default::default()
        };
        group.tick(&mut desktop, Some(MEMBERS));
        group.tick(&mut desktop, None);
        group.tick(&mut desktop, Some(MEMBERS));
        assert_eq!(desktop.raises, [(2, 1), (3, 1)]);
    }
}
