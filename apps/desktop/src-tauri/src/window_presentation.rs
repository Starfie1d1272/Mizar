//! Keep native window mutations separate from the high-frequency drawing loop.
//! WebviewWindow::hide() only hides the HWND in Tauri 2.12.1; the controller
//! must also learn about hidden/minimized windows (Microsoft's IsVisible contract).
use crate::geometry::Rect;
use std::{ffi::OsStr, path::{Path, PathBuf}};
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
        self.0.inner_size().ok().map(|size| (size.width, size.height))
    }
    fn position(&self) -> Option<(i32, i32)> {
        self.0.outer_position().ok().map(|point| (point.x, point.y))
    }
    fn resize(&mut self, size: (u32, u32)) -> Result<(), String> {
        self.0.set_size(PhysicalSize::new(size.0, size.1)).map_err(|e| e.to_string())
    }
    fn move_to(&mut self, position: (i32, i32)) -> Result<(), String> {
        self.0.set_position(PhysicalPosition::new(position.0, position.1)).map_err(|e| e.to_string())
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

fn visibility_change(window_visible: bool, minimized: bool, controller_visible: bool) -> Option<bool> {
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
        if visible { window.show()?; } else { window.hide()?; }
    }
    sync_visibility(window)
}

/// The existing Host worker bounds dispatch to one pending tick. This also
/// covers OS minimize/restore and Tauri close-to-hide, including tool windows.
pub fn sync_all(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let _ = sync_visibility(window);
    }
}

fn profile_path(
    root: &Path,
    option: Option<&OsStr>,
    override_folder: Option<&OsStr>,
) -> Result<Option<PathBuf>, String> {
    match option {
        None => Ok(None),
        Some(value) if value == OsStr::new("0") => Ok(None),
        Some(value) if value == OsStr::new("1") => {
            if override_folder.is_some_and(|value| !value.is_empty()) {
                return Err("WEBVIEW2_USER_DATA_FOLDER 会覆盖雷达隔离目录，请先取消该环境设置。".into());
            }
            if !root.is_absolute() {
                return Err("雷达隔离目录必须位于绝对状态目录中。".into());
            }
            // One stable optional profile, not a directory per session/map/RC.
            Ok(Some(root.join("webview2").join("workspace-radar")))
        }
        Some(_) => Err("MIZAR_RADAR_PROCESS_ISOLATION 只接受 0 或 1。".into()),
    }
}

/// Explicit, off-by-default compatibility candidate. A distinct user-data
/// folder gives the radar-bearing workspace its own WebView2 process collection.
/// It does not isolate the physical GPU or prove a performance improvement.
pub fn radar_profile(root: &Path) -> Result<Option<PathBuf>, String> {
    let option = std::env::var_os("MIZAR_RADAR_PROCESS_ISOLATION");
    let override_folder = std::env::var_os("WEBVIEW2_USER_DATA_FOLDER");
    let path = profile_path(root, option.as_deref(), override_folder.as_deref())?;
    if let Some(path) = &path {
        std::fs::create_dir_all(path).map_err(|_| "雷达隔离目录无法创建。".to_string())?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeWindow {
        size: Option<(u32, u32)>,
        position: Option<(i32, i32)>,
        resize_moves_to: Option<(i32, i32)>,
        fail_resize: bool,
        calls: Vec<&'static str>,
    }
    impl GeometryTarget for FakeWindow {
        fn size(&self) -> Option<(u32, u32)> { self.size }
        fn position(&self) -> Option<(i32, i32)> { self.position }
        fn resize(&mut self, size: (u32, u32)) -> Result<(), String> {
            self.calls.push("resize");
            if self.fail_resize { return Err("resize failed".into()); }
            self.size = Some(size);
            if let Some(position) = self.resize_moves_to { self.position = Some(position); }
            Ok(())
        }
        fn move_to(&mut self, position: (i32, i32)) -> Result<(), String> {
            self.calls.push("move");
            self.position = Some(position);
            Ok(())
        }
    }
    fn rect() -> Rect { Rect { x: -1280, y: 80, width: 1920, height: 1080 } }
    fn window() -> FakeWindow {
        FakeWindow { size: Some((1920, 1080)), position: Some((-1280, 80)), ..Default::default() }
    }

    #[test]
    fn unchanged_polling_has_no_native_mutations() {
        let mut window = window();
        for _ in 0..2400 { reconcile_geometry(&mut window, rect()).unwrap(); }
        assert!(window.calls.is_empty());
    }
    #[test]
    fn only_changed_dimensions_are_written() {
        let mut window = window();
        window.size = Some((1280, 720));
        reconcile_geometry(&mut window, rect()).unwrap();
        assert_eq!(window.calls, ["resize"]);
        window.calls.clear();
        window.position = Some((0, 0));
        reconcile_geometry(&mut window, rect()).unwrap();
        assert_eq!(window.calls, ["move"]);
    }
    #[test]
    fn external_move_and_dpi_resize_are_not_hidden_by_a_requested_rect_cache() {
        let mut window = window();
        reconcile_geometry(&mut window, rect()).unwrap();
        window.size = Some((1280, 720));
        window.position = Some((0, 0));
        reconcile_geometry(&mut window, rect()).unwrap();
        assert_eq!(window.calls, ["resize", "move"]);
        window.calls.clear();
        reconcile_geometry(&mut window, rect()).unwrap();
        assert!(window.calls.is_empty());
    }
    #[test]
    fn rechecks_position_after_a_resize_moves_the_native_window() {
        let mut window = window();
        window.size = Some((1280, 720));
        window.resize_moves_to = Some((30, 40));
        reconcile_geometry(&mut window, rect()).unwrap();
        assert_eq!(window.calls, ["resize", "move"]);
        assert_eq!(window.position, Some((-1280, 80)));
    }
    #[test]
    fn missing_readback_and_recreated_windows_reapply_geometry() {
        let mut window = FakeWindow::default();
        reconcile_geometry(&mut window, rect()).unwrap();
        assert_eq!(window.calls, ["resize", "move"]);
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
    #[test]
    fn nonpositive_dimensions_never_reach_unsigned_native_size() {
        for (width, height) in [(0, 1080), (-1, 1080), (1920, 0), (1920, -1)] {
            let mut window = window();
            assert!(reconcile_geometry(&mut window, Rect { width, height, ..rect() }).is_err());
            assert!(window.calls.is_empty());
        }
    }
    #[test]
    fn visibility_requires_a_shown_nonminimized_native_window() {
        for window_visible in [false, true] {
            for minimized in [false, true] {
                let desired = window_visible && !minimized;
                assert_eq!(visibility_change(window_visible, minimized, desired), None);
                assert_eq!(visibility_change(window_visible, minimized, !desired), Some(desired));
            }
        }
    }
    #[test]
    fn hide_minimize_restore_and_retry_do_not_lose_visibility() {
        let mut controller = true;
        for (shown, minimized, expected) in [
            (false, false, false), (false, false, false),
            (true, false, true), (true, true, false), (true, false, true),
        ] {
            if let Some(next) = visibility_change(shown, minimized, controller) { controller = next; }
            assert_eq!(controller, expected);
        }
        // A failed native setter leaves actual unchanged; the next tick retries.
        assert_eq!(visibility_change(false, false, true), Some(false));
        assert_eq!(visibility_change(false, false, true), Some(false));
    }
    #[test]
    fn isolation_is_explicit_and_uses_one_stable_profile() {
        let root = std::env::temp_dir().join("mizar-native-profile-test");
        assert_eq!(profile_path(&root, None, None).unwrap(), None);
        assert_eq!(profile_path(&root, Some(OsStr::new("0")), None).unwrap(), None);
        assert_eq!(profile_path(&root, Some(OsStr::new("1")), None).unwrap(),
            Some(root.join("webview2/workspace-radar")));
        for invalid in ["", "true", "auto", "../elsewhere"] {
            assert!(profile_path(&root, Some(OsStr::new(invalid)), None).is_err());
        }
        assert!(profile_path(Path::new("relative"), Some(OsStr::new("1")), None).is_err());
        assert!(profile_path(&root, Some(OsStr::new("1")), Some(OsStr::new("override"))).is_err());
        assert_eq!(profile_path(&root, None, Some(OsStr::new("override"))).unwrap(), None);
        assert!(profile_path(&root, Some(OsStr::new("1")), Some(OsStr::new(""))).unwrap().is_some());
    }
}
