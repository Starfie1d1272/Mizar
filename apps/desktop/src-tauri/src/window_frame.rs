//! Window-local chrome only; never changes desktop or Steam preferences.
use std::ffi::c_void;

#[link(name = "user32")]
extern "system" {
    fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
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
    pid: u32,
    style: i32,
    corner: Option<u32>,
    border: Option<u32>,
}
impl GameFrame {
    pub fn capture(hwnd: isize, pid: u32) -> Option<Self> {
        let style = unsafe { GetWindowLongW(hwnd, -16) };
        (style != 0).then(|| Self {
            hwnd,
            pid,
            style,
            corner: attribute(hwnd, CORNER),
            border: attribute(hwnd, BORDER),
        })
    }
    fn exists(&self) -> bool {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(self.hwnd, &mut pid);
        }
        pid == self.pid
    }
    pub fn apply(&self) {
        if !self.exists() {
            return;
        }
        let style = unsafe { GetWindowLongW(self.hwnd, -16) };
        if style & FRAME_STYLE != 0 {
            unsafe {
                SetWindowLongW(self.hwnd, -16, style & !FRAME_STYLE);
                SetWindowPos(self.hwnd, 0, 0, 0, 0, 0, 0x0037); // frame changed; no move/resize/activate/z-order
            }
        }
        square_window(self.hwnd);
    }
}
impl Drop for GameFrame {
    fn drop(&mut self) {
        if !self.exists() {
            return;
        }
        unsafe {
            SetWindowLongW(self.hwnd, -16, self.style);
            SetWindowPos(self.hwnd, 0, 0, 0, 0, 0, 0x0037);
        }
        if let Some(value) = self.corner {
            set_attribute(self.hwnd, CORNER, value);
        }
        if let Some(value) = self.border {
            set_attribute(self.hwnd, BORDER, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(
            ex: u32,
            class: *const u16,
            name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: isize,
            menu: isize,
            instance: isize,
            param: *const c_void,
        ) -> isize;
        fn DestroyWindow(hwnd: isize) -> i32;
    }
    #[test]
    fn native_frame_is_removed_and_original_attributes_are_restored() {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                0x00cf0000,
                -10000,
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
        let frame = GameFrame::capture(hwnd, std::process::id()).unwrap();
        let original_style = frame.style;
        let original_corner = frame.corner;
        let original_border = frame.border;
        frame.apply();
        assert_eq!(unsafe { GetWindowLongW(hwnd, -16) } & FRAME_STYLE, 0);
        drop(frame);
        assert_eq!(unsafe { GetWindowLongW(hwnd, -16) }, original_style);
        assert_eq!(attribute(hwnd, CORNER), original_corner);
        assert_eq!(attribute(hwnd, BORDER), original_border);
        unsafe {
            DestroyWindow(hwnd);
        }
    }
}
