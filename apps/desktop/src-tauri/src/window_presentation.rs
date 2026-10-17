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

/// Attempt both panels even when one fails. A later exit retry checks each
/// window's actual visibility again through set_visible.
pub fn hide_panels(mut hide: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
    let mut result = Ok(());
    for label in ["workspace-left", "workspace-dock"] {
        if let Err(error) = hide(label) {
            if result.is_ok() {
                result = Err(error);
            }
        }
    }
    result
}

#[link(name = "user32")]
extern "system" {
    fn IsWindow(hwnd: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn IsIconic(hwnd: isize) -> i32;
    fn ShowWindow(hwnd: isize, command: i32) -> i32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, w: i32, h: i32, flags: u32) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> u32;
}

trait VisibilityTarget {
    fn visible(&self) -> std::io::Result<bool>;
    fn set_visible_without_activation(&mut self, visible: bool) -> std::io::Result<()>;
}
fn reconcile_visibility(target: &mut impl VisibilityTarget, visible: bool) -> std::io::Result<()> {
    if target.visible()? != visible {
        target.set_visible_without_activation(visible)?;
    }
    if target.visible()? != visible {
        return Err(std::io::Error::other(
            "native window visibility did not match the request",
        ));
    }
    Ok(())
}
struct NativeVisibility(isize);
impl VisibilityTarget for NativeVisibility {
    fn visible(&self) -> std::io::Result<bool> {
        if unsafe { IsWindow(self.0) } == 0 {
            return Err(std::io::Error::other("native window no longer exists"));
        }
        Ok(unsafe { IsWindowVisible(self.0) } != 0)
    }
    fn set_visible_without_activation(&mut self, visible: bool) -> std::io::Result<()> {
        // NOSIZE | NOMOVE | NOZORDER | NOACTIVATE. No foreground or topmost change.
        let flags = 0x0017 | if visible { 0x0040 } else { 0x0080 };
        if unsafe { SetWindowPos(self.0, 0, 0, 0, 0, 0, flags) } == 0 {
            let code = unsafe { GetLastError() };
            return Err(if code == 0 {
                std::io::Error::other("SetWindowPos failed without an extended error")
            } else {
                std::io::Error::from_raw_os_error(code as i32)
            });
        }
        Ok(())
    }
}
fn set_native_visible_without_activation(hwnd: isize, visible: bool) -> std::io::Result<()> {
    reconcile_visibility(&mut NativeVisibility(hwnd), visible)
}

/// Tao 0.37.1 caches VISIBLE for hide(), while is_visible() reads the HWND.
/// A native show leaves its initial hidden cache unchanged. Use the same native
/// path for both panel transitions and return only after the UI thread readback.
fn set_workspace_visibility(window: &WebviewWindow, visible: bool) -> Result<(), String> {
    let current = window.clone();
    let (completed, result) = std::sync::mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        let log = current.state::<crate::startup_log::DesktopLog>();
        let operation = (|| {
            let hwnd = current.hwnd().map_err(|error| error.to_string())?.0 as isize;
            let before = unsafe { IsWindowVisible(hwnd) } != 0;
            log.event("workspace_panel_visibility", "begin", Some(&serde_json::json!({"label":current.label(),"visible":visible,"before":before}).to_string()));
            if visible && unsafe { IsIconic(hwnd) } != 0 {
                unsafe { ShowWindow(hwnd, 4); } // SW_SHOWNOACTIVATE
            }
            set_native_visible_without_activation(hwnd, visible).map_err(|error| error.to_string())?;
            sync_visibility(&current).map_err(|error| error.to_string())?;
            Ok(())
        })();
        let after = current.hwnd().ok().map(|hwnd| unsafe { IsWindowVisible(hwnd.0 as isize) } != 0);
        log.event("workspace_panel_visibility", if operation.is_ok() {"success"} else {"failure"},
            Some(&serde_json::json!({"label":current.label(),"visible":visible,"after":after,"error":operation.as_ref().err()}).to_string()));
        let _ = completed.send(operation);
    }).map_err(|error| error.to_string())?;
    // tauri-runtime-wry 2.12.1 executes this dispatch inline when already on the
    // UI thread. Background callers await the actual mutation, not just enqueue.
    result
        .recv()
        .map_err(|_| "工作台窗口显隐结果未能确认。".to_owned())?
}
pub fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    set_workspace_visibility(window, true)
}
pub fn hide_without_activation(window: &WebviewWindow) -> Result<(), String> {
    set_workspace_visibility(window, false)
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

    #[test]
    fn native_show_then_hide_ignores_stale_toolkit_cache_and_checks_readback() {
        struct Panel {
            toolkit_visible: bool,
            actual_visible: bool,
            ignore_change: bool,
        }
        impl VisibilityTarget for Panel {
            fn visible(&self) -> std::io::Result<bool> {
                Ok(self.actual_visible)
            }
            fn set_visible_without_activation(&mut self, value: bool) -> std::io::Result<()> {
                if !self.ignore_change {
                    self.actual_visible = value;
                }
                Ok(())
            }
        }
        let mut panel = Panel {
            toolkit_visible: false,
            actual_visible: false,
            ignore_change: false,
        };
        reconcile_visibility(&mut panel, true).unwrap();
        assert!(panel.actual_visible);
        assert!(!panel.toolkit_visible); // initially hidden Tao cache is still stale
        reconcile_visibility(&mut panel, false).unwrap();
        assert!(!panel.actual_visible);
        reconcile_visibility(&mut panel, true).unwrap();
        panel.ignore_change = true;
        assert!(reconcile_visibility(&mut panel, false).is_err());
        assert!(panel.actual_visible); // a no-op must never be reported as hidden
    }

    #[test]
    fn real_hwnd_native_show_hide_roundtrip_preserves_foreground() {
        #[link(name = "user32")]
        extern "system" {
            fn CreateWindowExW(
                ex_style: u32,
                class: *const u16,
                title: *const u16,
                style: u32,
                x: i32,
                y: i32,
                width: i32,
                height: i32,
                parent: isize,
                menu: isize,
                instance: isize,
                parameter: *mut std::ffi::c_void,
            ) -> isize;
            fn DestroyWindow(hwnd: isize) -> i32;
            fn GetForegroundWindow() -> isize;
        }
        struct OwnedWindow(isize);
        impl Drop for OwnedWindow {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "Mizar visibility regression\0".encode_utf16().collect();
        let window = OwnedWindow(unsafe {
            CreateWindowExW(
                0x08000080,
                class.as_ptr(),
                title.as_ptr(),
                0x80000000,
                0,
                0,
                100,
                100,
                0,
                0,
                0,
                std::ptr::null_mut(),
            )
        });
        assert_ne!(
            window.0,
            0,
            "CreateWindowExW: {}",
            std::io::Error::last_os_error()
        );
        let foreground = unsafe { GetForegroundWindow() };
        assert_eq!(unsafe { IsWindowVisible(window.0) }, 0);
        for _ in 0..3 {
            set_native_visible_without_activation(window.0, true).unwrap();
            assert_ne!(unsafe { IsWindowVisible(window.0) }, 0);
            assert_eq!(unsafe { GetForegroundWindow() }, foreground);
            set_native_visible_without_activation(window.0, false).unwrap();
            assert_eq!(unsafe { IsWindowVisible(window.0) }, 0);
            assert_eq!(unsafe { GetForegroundWindow() }, foreground);
        }
    }

    #[test]
    fn panel_hide_failure_attempts_the_other_panel_and_allows_retry() {
        let mut left_visible = true;
        let mut dock_visible = true;
        let result = hide_panels(|label| {
            if label == "workspace-left" {
                Err("left hide failed".into())
            } else {
                dock_visible = false;
                Ok(())
            }
        });
        assert_eq!(result.unwrap_err(), "left hide failed");
        assert!(left_visible);
        assert!(!dock_visible);

        hide_panels(|label| {
            if label == "workspace-left" {
                left_visible = false;
            } else {
                dock_visible = false;
            }
            Ok(())
        })
        .unwrap();
        assert!(!left_visible);
        assert!(!dock_visible);
    }
}
