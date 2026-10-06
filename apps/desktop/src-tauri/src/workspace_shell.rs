//! Window-scoped fullscreen hints; never change Explorer's global taskbar settings.
use std::collections::BTreeSet;
use windows::Win32::{
    Foundation::{HWND, RPC_E_CHANGED_MODE},
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    },
    UI::Shell::{ITaskbarList2, TaskbarList},
};

struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

fn mark(hwnd: isize, fullscreen: bool) -> bool {
    if !fullscreen && !crate::windows_host::window_exists(hwnd) {
        return true;
    }
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return false;
        }
        let _apartment = Apartment(initialized.is_ok());
        let Ok(taskbar) =
            CoCreateInstance::<_, ITaskbarList2>(&TaskbarList, None, CLSCTX_INPROC_SERVER)
        else {
            return false;
        };
        taskbar.HrInit().is_ok()
            && taskbar
                .MarkFullscreenWindow(HWND(hwnd as *mut _), fullscreen)
                .is_ok()
    }
}

#[derive(Default)]
pub struct FullscreenScope {
    marked: BTreeSet<isize>,
}
impl FullscreenScope {
    pub fn synchronize(&mut self, windows: &[isize]) -> bool {
        self.sync_with(windows, mark)
    }
    fn sync_with(&mut self, windows: &[isize], mut apply: impl FnMut(isize, bool) -> bool) -> bool {
        let wanted: BTreeSet<_> = windows.iter().copied().filter(|hwnd| *hwnd != 0).collect();
        for hwnd in self.marked.difference(&wanted).copied().collect::<Vec<_>>() {
            if apply(hwnd, false) {
                self.marked.remove(&hwnd);
            }
        }
        for hwnd in wanted.difference(&self.marked).copied().collect::<Vec<_>>() {
            if apply(hwnd, true) {
                self.marked.insert(hwnd);
            }
        }
        self.marked == wanted
    }
}
impl Drop for FullscreenScope {
    fn drop(&mut self) {
        for hwnd in &self.marked {
            let _ = mark(*hwnd, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entering_replacing_and_hiding_only_touch_scoped_windows() {
        let mut scope = FullscreenScope::default();
        let mut calls = Vec::new();
        assert!(scope.sync_with(&[1, 2, 3, 0, 3], |hwnd, enabled| {
            calls.push((hwnd, enabled));
            true
        }));
        assert_eq!(calls, [(1, true), (2, true), (3, true)]);
        calls.clear();
        assert!(scope.sync_with(&[1, 2, 3], |hwnd, enabled| {
            calls.push((hwnd, enabled));
            true
        }));
        assert!(calls.is_empty());
        assert!(scope.sync_with(&[1, 2, 4], |hwnd, enabled| {
            calls.push((hwnd, enabled));
            true
        }));
        assert_eq!(calls, [(3, false), (4, true)]);
        calls.clear();
        assert!(scope.sync_with(&[], |hwnd, enabled| {
            calls.push((hwnd, enabled));
            true
        }));
        assert_eq!(calls, [(1, false), (2, false), (4, false)]);
    }
    #[test]
    fn a_failed_hint_keeps_the_work_area_fallback_and_can_be_retried() {
        let mut scope = FullscreenScope::default();
        assert!(!scope.sync_with(&[1], |_, _| false));
        assert!(scope.marked.is_empty());
        assert!(scope.sync_with(&[1], |_, _| true));
        assert!(!scope.sync_with(&[], |_, _| false));
        assert_eq!(scope.marked, BTreeSet::from([1]));
        assert!(scope.sync_with(&[], |_, _| true));
    }
}
