//! Keep native window mutations separate from the high-frequency drawing loop.
//! WebviewWindow::hide() only hides the HWND in Tauri 2.12.1; the controller
//! must also learn about hidden/minimized windows (Microsoft's IsVisible contract).
use crate::geometry::Rect;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

trait GeometryTarget {
    fn size(&self) -> Option<(u32, u32)>;
    fn position(&self) -> Option<(i32, i32)>;
    fn resize(&mut self, size: (u32, u32)) -> Result<(), String>;
    fn move_to(&mut self, position: (i32, i32)) -> Result<(), String>;
}

struct NativeGeometry<'a>(&'a WebviewWindow);
impl GeometryTarget for NativeGeometry<'_> {
    fn size(&self) -> Option<(u32, u32)> {
        self.0
            .inner_size()
            .ok()
            .map(|size| (size.width, size.height))
    }
    fn position(&self) -> Option<(i32, i32)> {
        self.0.outer_position().ok().map(|point| (point.x, point.y))
    }
    fn resize(&mut self, size: (u32, u32)) -> Result<(), String> {
        self.0
            .set_size(PhysicalSize::new(size.0, size.1))
            .map_err(|e| e.to_string())
    }
    fn move_to(&mut self, position: (i32, i32)) -> Result<(), String> {
        self.0
            .set_position(PhysicalPosition::new(position.0, position.1))
            .map_err(|e| e.to_string())
    }
}

fn reconcile_geometry(target: &mut impl GeometryTarget, rect: Rect) -> Result<(), String> {
    if rect.width <= 0 || rect.height <= 0 {
        return Err("窗口尺寸必须为正。".into());
    }
    let size = (rect.width as u32, rect.height as u32);
    if target.size() != Some(size) {
        target.resize(size)?;
    }
    // A native resize can also move the window. Read back instead of caching
    // the last requested rectangle, so DPI changes and external moves recover.
    let position = (rect.x, rect.y);
    if target.position() != Some(position) {
        target.move_to(position)?;
    }
    Ok(())
}

pub fn place(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    if rect.width <= 0 || rect.height <= 0 {
        return set_visible(window, false).map_err(|error| error.to_string());
    }
    reconcile_geometry(&mut NativeGeometry(window), rect)
}

fn visibility_change(
    window_visible: bool,
    minimized: bool,
    controller_visible: bool,
) -> Option<bool> {
    let desired = window_visible && !minimized;
    (desired != controller_visible).then_some(desired)
}

/// Read visibility inside the UI-thread closure, not before it is dispatched.
/// No controller reference escapes its apartment and no UI-thread wait is added.
pub fn sync_visibility(window: &WebviewWindow) -> tauri::Result<()> {
    let current = window.clone();
    window.with_webview(move |platform| {
        let (Ok(visible), Ok(minimized)) = (current.is_visible(), current.is_minimized()) else {
            return;
        };
        unsafe {
            let controller = platform.controller();
            let mut actual = Default::default();
            if controller.IsVisible(&mut actual).is_ok() {
                if let Some(desired) = visibility_change(visible, minimized, actual.as_bool()) {
                    // A failed setter is retried by the existing bounded Host tick.
                    let _ = controller.SetIsVisible(desired);
                }
            }
        }
    })
}

pub fn set_visible(window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
    if window.is_visible().ok() != Some(visible) {
        if visible {
            window.show()?;
        } else {
            window.hide()?;
        }
    }
    sync_visibility(window)
}

#[link(name = "user32")]
extern "system" {
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn IsIconic(hwnd: isize) -> i32;
    fn ShowWindow(hwnd: isize, command: i32) -> i32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, w: i32, h: i32, flags: u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> u32;
}

fn set_native_visible_without_activation(hwnd: isize, visible: bool) -> std::io::Result<()> {
    if (unsafe { IsWindowVisible(hwnd) } != 0) == visible {
        return Ok(());
    }
    // Preserve the HUD's geometry, z band and the user's foreground window.
    const KEEP_PLACEMENT: u32 = 0x0001 | 0x0002 | 0x0004 | 0x0010;
    const SHOW_WINDOW: u32 = 0x0040;
    const HIDE_WINDOW: u32 = 0x0080;
    let flags = KEEP_PLACEMENT | if visible { SHOW_WINDOW } else { HIDE_WINDOW };
    if unsafe { SetWindowPos(hwnd, 0, 0, 0, 0, 0, flags) } == 0 {
        return Err(std::io::Error::from_raw_os_error(
            unsafe { GetLastError() } as i32
        ));
    }
    Ok(())
}

/// Reopening a workspace is visibility work, not an input-target selection.
/// As with HUD visibility, perform native mutations on the owning UI thread.
pub fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    let current = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let hwnd = current.hwnd().map_err(|error| error.to_string())?.0 as isize;
                if unsafe { IsIconic(hwnd) } != 0 {
                    unsafe {
                        ShowWindow(hwnd, 4);
                    } // SW_SHOWNOACTIVATE
                }
                set_native_visible_without_activation(hwnd, true)
                    .map_err(|error| error.to_string())?;
                sync_visibility(&current).map_err(|error| error.to_string())
            })();
            if let Err(error) = result {
                current.state::<crate::startup_log::DesktopLog>().event(
                    "workspace_visibility",
                    "failure",
                    Some(&error),
                );
            }
        })
        .map_err(|error| error.to_string())
}

/// HUD-only visibility: Tao 0.37.1's later show() uses SW_SHOW even for a
/// nonfocusable window; focused(false) only protects initial construction.
/// Keep both transitions native because Tao caches its own VISIBLE flag.
/// Async production commands also reach this function. Dispatch the whole
/// operation before reading HWND: synchronous cross-thread SetWindowPos can
/// wait on a window thread that is itself servicing a runtime getter.
pub fn set_overlay_visible(window: &WebviewWindow, visible: bool) -> Result<(), String> {
    let current = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let hwnd = current.hwnd().map_err(|error| error.to_string())?;
                set_native_visible_without_activation(hwnd.0 as isize, visible)
                    .map_err(|error| format!("HUD SetWindowPos failed: {error}"))?;
                sync_visibility(&current).map_err(|error| error.to_string())
            })();
            if let Err(error) = result {
                current.state::<crate::startup_log::DesktopLog>().event(
                    "program_overlay_visibility",
                    "failure",
                    Some(&error),
                );
            }
        })
        .map_err(|error| error.to_string())
}
/// The existing Host worker bounds dispatch to one pending tick. This also
/// covers OS minimize/restore and Tauri close-to-hide, including tool windows.
pub fn sync_all(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let _ = sync_visibility(window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    #[derive(Default, Debug, PartialEq)]
    struct NativeRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
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
        fn GetForegroundWindow() -> isize;
        fn GetWindowRect(hwnd: isize, rect: *mut NativeRect) -> i32;
        fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
    }
    struct NativeWindow(isize);
    impl Drop for NativeWindow {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }
    fn native_window(ex_style: u32) -> NativeWindow {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let hwnd = unsafe {
            CreateWindowExW(
                ex_style,
                class.as_ptr(),
                class.as_ptr(),
                0x8000_0000, // WS_POPUP, initially hidden
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
        NativeWindow(hwnd)
    }
    fn native_rect(hwnd: isize) -> NativeRect {
        let mut rect = NativeRect::default();
        assert_ne!(unsafe { GetWindowRect(hwnd, &mut rect) }, 0);
        rect
    }


    #[derive(Default)]
    struct FakeWindow {
        size: Option<(u32, u32)>,
        position: Option<(i32, i32)>,
        resize_moves_to: Option<(i32, i32)>,
        fail_resize: bool,
        calls: Vec<&'static str>,
    }
    impl GeometryTarget for FakeWindow {
        fn size(&self) -> Option<(u32, u32)> {
            self.size
        }
        fn position(&self) -> Option<(i32, i32)> {
            self.position
        }
        fn resize(&mut self, size: (u32, u32)) -> Result<(), String> {
            self.calls.push("resize");
            if self.fail_resize {
                return Err("resize failed".into());
            }
            self.size = Some(size);
            if let Some(position) = self.resize_moves_to {
                self.position = Some(position);
            }
            Ok(())
        }
        fn move_to(&mut self, position: (i32, i32)) -> Result<(), String> {
            self.calls.push("move");
            self.position = Some(position);
            Ok(())
        }
    }
    fn rect() -> Rect {
        Rect {
            x: -1280,
            y: 80,
            width: 1920,
            height: 1080,
        }
    }
    fn window() -> FakeWindow {
        FakeWindow {
            size: Some((1920, 1080)),
            position: Some((-1280, 80)),
            ..Default::default()
        }
    }






    #[test]
    fn failed_write_does_not_become_a_successful_cached_target() {
        let mut window = window();
        window.size = Some((1280, 720));
        window.fail_resize = true;
        assert!(reconcile_geometry(&mut window, rect()).is_err());
        window.fail_resize = false;
        reconcile_geometry(&mut window, rect()).unwrap();
        assert_eq!(window.calls, ["resize", "resize"]);
    }



}
