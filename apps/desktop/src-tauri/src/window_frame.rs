//! Window-local chrome only; never changes desktop or Steam preferences.
use std::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct WindowRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
    fn GetWindowRect(hwnd: isize, rect: *mut WindowRect) -> i32;
    fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, w: i32, h: i32, flags: u32) -> i32;
}
#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(hwnd: isize, attribute: u32, value: *mut c_void, size: u32) -> i32;
    fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const c_void, size: u32) -> i32;
}
const CORNER: u32 = 33;
const BORDER: u32 = 34;
const FRAME_STYLE: i32 = 0x00c4_0000; // WS_CAPTION | WS_THICKFRAME

fn attribute(hwnd: isize, name: u32) -> Option<u32> {
    let mut value = 0u32;
    (unsafe { DwmGetWindowAttribute(hwnd, name, &mut value as *mut _ as _, 4) } >= 0)
        .then_some(value)
}
fn set_attribute(hwnd: isize, name: u32, value: u32) {
    unsafe {
        DwmSetWindowAttribute(hwnd, name, &value as *const _ as _, 4);
    }
}
pub fn square_window(hwnd: isize) {
    set_attribute(hwnd, CORNER, 1); // DWMWCP_DONOTROUND
    set_attribute(hwnd, BORDER, 0xffff_fffe); // DWMWA_COLOR_NONE
}

pub struct GameFrame {
    hwnd: isize,
    process: crate::managed_cs2::WorkspaceProcess,
    style: i32,
    original: WindowRect,
    corner: Option<u32>,
    border: Option<u32>,
    retired: bool,
}
impl GameFrame {
    pub fn capture(hwnd: isize, process: crate::managed_cs2::WorkspaceProcess) -> Option<Self> {
        let style = unsafe { GetWindowLongW(hwnd, -16) };
        let mut original = WindowRect::default();
        let measured = unsafe { GetWindowRect(hwnd, &mut original) } != 0;
        (style != 0 && measured && original.right > original.left && original.bottom > original.top)
            .then(|| Self {
                hwnd,
                process,
                style,
                original,
                corner: attribute(hwnd, CORNER),
                border: attribute(hwnd, BORDER),
                retired: false,
            })
    }
    fn exists(&self) -> bool {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(self.hwnd, &mut pid);
        }
        self.process.is_running() && pid == self.process.pid
    }
    pub fn apply(&self) {
        if !self.exists() {
            return;
        }
        let style = unsafe { GetWindowLongW(self.hwnd, -16) };
        if style & FRAME_STYLE != 0 {
            unsafe {
                SetWindowLongW(self.hwnd, -16, style & !FRAME_STYLE);
                SetWindowPos(self.hwnd, 0, 0, 0, 0, 0, 0x4037); // async frame changed; no move/resize/activate/z-order
            }
        }
        square_window(self.hwnd);
    }
}
impl GameFrame {
    pub fn retire(&mut self) -> Result<(), std::io::Error> {
        self.retired = true;
        if !self.exists() {
            return Ok(());
        }
        let submitted = unsafe {
            SetWindowLongW(self.hwnd, -16, self.style);
            SetWindowPos(
                self.hwnd,
                0,
                self.original.left,
                self.original.top,
                self.original.right - self.original.left,
                self.original.bottom - self.original.top,
                0x4034,
            ) != 0
        };
        let result = if submitted {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        };
        if let Some(value) = self.corner {
            set_attribute(self.hwnd, CORNER, value);
        }
        if let Some(value) = self.border {
            set_attribute(self.hwnd, BORDER, value);
        }
        result
    }
}
impl Drop for GameFrame {
    fn drop(&mut self) {
        if !self.retired {
            let _ = self.retire();
        }
    }
}
