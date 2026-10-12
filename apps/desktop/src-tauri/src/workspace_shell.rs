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
