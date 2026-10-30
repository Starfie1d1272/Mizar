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
static CONTROLLER_OBSERVATIONS: std::sync::Mutex<Vec<(String, String)>> =
    std::sync::Mutex::new(Vec::new());

fn dispatch_visibility(
    window: &WebviewWindow,
    completed: Option<std::sync::mpsc::SyncSender<()>>,
) -> tauri::Result<()> {
    let current = window.clone();
    let force_snapshot = completed.is_some();
    let generation = (window.label() == "program-overlay").then(|| {
        window
            .state::<crate::HostState>()
            .overlay_generation
            .load(std::sync::atomic::Ordering::Acquire)
    });
    window.with_webview(move |platform| {
        if generation.is_some_and(|generation| current.state::<crate::HostState>().overlay_generation.load(std::sync::atomic::Ordering::Acquire) != generation) {
            if let Some(sender) = completed { let _ = sender.send(()); }
            return;
        }
        let visible = current.is_visible().map_err(|error| error.to_string());
        let minimized = current.is_minimized().map_err(|error| error.to_string());
        unsafe {
            let controller = platform.controller();
            let mut actual = Default::default();
            let read = controller.IsVisible(&mut actual);
            let mut bounds = Default::default();
            let bounds_read = generation.map(|_| controller.Bounds(&mut bounds));
            let desired = visible.as_ref().ok().zip(minimized.as_ref().ok()).map(|(visible, minimized)| *visible && !*minimized);
            let setter = match (desired, &read) {
                (Some(desired), Ok(())) => visibility_change(desired, false, actual.as_bool())
                    .map(|value| controller.SetIsVisible(value)),
                _ => None,
            };
            let mut after = Default::default();
            let after_read = controller.IsVisible(&mut after);
            let hresult = |error: &windows::core::Error| format!("0x{:08X}", error.code().0 as u32);
            let failed = visible.is_err() || minimized.is_err() || read.is_err() || bounds_read.as_ref().is_some_and(|result| result.is_err())
                || setter.as_ref().is_some_and(|result| result.is_err()) || after_read.is_err();
            if current.label() == "program-overlay" || failed {
                let detail = serde_json::json!({
                    "label":current.label(), "generation":generation,
                    "desired":desired, "visible":read.as_ref().ok().map(|_| actual.as_bool()),
                    "after":after_read.as_ref().ok().map(|_| after.as_bool()),
                    "bounds":bounds_read.as_ref().and_then(|result| result.as_ref().ok()).map(|_| [bounds.left, bounds.top, bounds.right, bounds.bottom]),
                    "windowError":visible.err(), "minimizedError":minimized.err(),
                    "visibleHresult":read.as_ref().err().map(hresult),
                    "boundsHresult":bounds_read.as_ref().and_then(|result| result.as_ref().err()).map(hresult),
                    "setHresult":setter.as_ref().and_then(|result| result.as_ref().err()).map(hresult),
                    "afterHresult":after_read.as_ref().err().map(hresult)
                }).to_string();
                let mut last = CONTROLLER_OBSERVATIONS.lock().unwrap_or_else(|error| error.into_inner());
                let previous = last.iter_mut().find(|(label, _)| label == current.label());
                let changed = if let Some((_, value)) = previous {
                    if *value == detail { false } else { *value = detail.clone(); true }
                } else { last.push((current.label().to_string(), detail.clone())); true };
                if changed || force_snapshot {
                    current.state::<crate::startup_log::DesktopLog>().event("webview_controller_visibility", if failed { "failure" } else { "snapshot" }, Some(&detail));
                }
            }
        }
        if let Some(sender) = completed { let _ = sender.send(()); }
    })
}

/// Observe only this overlay's WebView2. Never terminate the shared browser process.
pub fn observe_process_failure(window: &WebviewWindow, generation: u64) -> Result<(), String> {
    let current = window.clone();
    window.with_webview(move |platform| unsafe {
        let log = current.state::<crate::startup_log::DesktopLog>();
        let result = (|| -> windows::core::Result<()> {
            let webview = platform.controller().CoreWebView2()?;
            let host = current.app_handle().clone();
            let handler = webview2_com::ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                let state = host.state::<crate::HostState>();
                let mut kind = Default::default();
                let result = args.as_ref().map(|args| args.ProcessFailedKind(&mut kind));
                let document = (state.overlay_generation.load(std::sync::atomic::Ordering::Acquire) == generation).then(|| state.overlay_document.load(std::sync::atomic::Ordering::Acquire));
                host.state::<crate::startup_log::DesktopLog>().event("program_overlay_process_failed", "failure",
                    Some(&serde_json::json!({"generation":generation,"documentId":document,"kind":result.as_ref().and_then(|value| value.as_ref().ok()).map(|_| kind.0),"hresult":result.as_ref().and_then(|value| value.as_ref().err()).map(|error| format!("0x{:08X}", error.code().0 as u32))}).to_string()));
                if result.as_ref().is_some_and(|result| result.is_ok()) && (kind.0 == 0 || kind.0 == 1) {
                    let _presentation = state.overlay_presentation.lock().unwrap_or_else(|error| error.into_inner());
                    if state.overlay_generation.load(std::sync::atomic::Ordering::Acquire) == generation {
                        state.overlay_ready.store(0, std::sync::atomic::Ordering::Release);
                        state.overlay_document.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                        state.overlay_epoch.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    }
                }
                Ok(())
            }));
            let mut token = 0;
            webview.add_ProcessFailed(&handler, &mut token)?;
            Ok(())
        })();
        if let Err(error) = result {
            log.event("program_overlay_process_observer", "failure", Some(&format!("generation={generation}; hresult=0x{:08X}", error.code().0 as u32)));
        }
    }).map_err(|error| error.to_string())
}

/// The controller runs on its apartment; failures are retained in the native log.
pub fn sync_visibility(window: &WebviewWindow) -> tauri::Result<()> {
    let result = dispatch_visibility(window, None);
    let key = format!("dispatch:{}", window.label());
    let mut observations = CONTROLLER_OBSERVATIONS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Err(error) = &result {
        let detail =
            serde_json::json!({"label": window.label(), "error": error.to_string()}).to_string();
        if let Some((_, previous)) = observations.iter_mut().find(|(label, _)| label == &key) {
            if *previous != detail {
                *previous = detail.clone();
                window.state::<crate::startup_log::DesktopLog>().event(
                    "webview_controller_dispatch",
                    "failure",
                    Some(&detail),
                );
            }
        } else {
            observations.push((key, detail.clone()));
            window.state::<crate::startup_log::DesktopLog>().event(
                "webview_controller_dispatch",
                "failure",
                Some(&detail),
            );
        }
    } else {
        observations.retain(|(label, _)| label != &key);
    }
    result
}

/// Called only by the recovery worker, never by the UI thread.
pub fn snapshot_controller(window: &WebviewWindow) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    dispatch_visibility(window, Some(sender)).map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "WebView2 快照超时。".into())
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
