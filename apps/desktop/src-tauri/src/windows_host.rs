use crate::geometry::{avoid_game_frame, overlap, overlay_visible, workspace_layout, Layout, Rect};

type Hwnd = isize;
type Monitor = isize;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinRect { left: i32, top: i32, right: i32, bottom: i32 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point { x: i32, y: i32 }
#[repr(C)]
struct MonitorInfo { size: u32, monitor: WinRect, work: WinRect, flags: u32 }

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize) -> i32;
    fn IsWindowVisible(hwnd: Hwnd) -> i32;
    fn IsWindow(hwnd: Hwnd) -> i32;
    fn IsIconic(hwnd: Hwnd) -> i32;
    fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
    fn GetClientRect(hwnd: Hwnd, rect: *mut WinRect) -> i32;
    fn GetWindowRect(hwnd: Hwnd, rect: *mut WinRect) -> i32;
    fn ClientToScreen(hwnd: Hwnd, point: *mut Point) -> i32;
    fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
    fn GetDpiForWindow(hwnd: Hwnd) -> u32;
    fn SetThreadDpiAwarenessContext(context: isize) -> isize;
    fn AdjustWindowRectExForDpi(rect: *mut WinRect, style: u32, menu: i32, ex_style: u32, dpi: u32) -> i32;
    fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, width: i32, height: i32, flags: u32) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    fn MonitorFromRect(rect: *const WinRect, flags: u32) -> Monitor;
    fn MonitorFromWindow(hwnd: Hwnd, flags: u32) -> Monitor;
    fn GetMonitorInfoW(monitor: Monitor, info: *mut MonitorInfo) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn QueryFullProcessImageNameW(process: isize, flags: u32, buffer: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const MONITOR_DEFAULTTOPRIMARY: u32 = 1;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;

// The tracker runs both on the Host worker and command dispatcher. Win32
// otherwise virtualizes coordinates differently from Tauri's physical pixels.
struct PhysicalCoordinates(isize);
impl PhysicalCoordinates {
    fn enter() -> Self { Self(unsafe { SetThreadDpiAwarenessContext(-4) }) }
}
impl Drop for PhysicalCoordinates {
    fn drop(&mut self) {
        if self.0 != 0 { unsafe { SetThreadDpiAwarenessContext(self.0); } }
    }
}

fn rect(value: WinRect) -> Rect {
    Rect { x: value.left, y: value.top, width: value.right - value.left, height: value.bottom - value.top }
}
fn win_rect(value: Rect) -> WinRect {
    WinRect { left: value.x, top: value.y, right: value.right(), bottom: value.bottom() }
}

fn is_cs2(pid: u32) -> bool {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process == 0 { return false; }
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let found = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        found != 0 && String::from_utf16_lossy(&buffer[..length as usize]).to_ascii_lowercase().ends_with("\\cs2.exe")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cs2Window { pub pid: u32, pub hwnd: isize }

unsafe extern "system" fn collect_window(hwnd: Hwnd, data: isize) -> i32 {
    if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 { return 1; }
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != 0 && is_cs2(pid) && client_rect(hwnd).is_some() {
        let windows = &mut *(data as *mut Vec<Cs2Window>);
        windows.push(Cs2Window { pid, hwnd });
    }
    1
}

pub fn find_cs2() -> Option<Cs2Window> {
    let mut windows = Vec::new();
    unsafe { EnumWindows(collect_window, &mut windows as *mut _ as isize); }
    windows.into_iter().next()
}

pub fn window_exists(hwnd: Hwnd) -> bool {
    unsafe { IsWindow(hwnd) != 0 }
}

pub fn client_rect(hwnd: Hwnd) -> Option<Rect> {
    unsafe {
        if IsWindow(hwnd) == 0 { return None; }
        let mut size = WinRect::default();
        let mut origin = Point::default();
        if GetClientRect(hwnd, &mut size) == 0 || ClientToScreen(hwnd, &mut origin) == 0 { return None; }
        let result = Rect { x: origin.x, y: origin.y, width: size.right, height: size.bottom };
        (result.width > 0 && result.height > 0).then_some(result)
    }
}

fn monitor_layout_area(monitor: Monitor, fullscreen: bool) -> Option<Rect> {
    unsafe {
        let mut info = MonitorInfo { size: std::mem::size_of::<MonitorInfo>() as u32, monitor: WinRect::default(), work: WinRect::default(), flags: 0 };
        (monitor != 0 && GetMonitorInfoW(monitor, &mut info) != 0).then(|| rect(if fullscreen { info.monitor } else { info.work }))
    }
}

pub fn choose_monitor(cs2: Option<Cs2Window>) -> Monitor {
    unsafe {
        if let Some(window) = cs2 {
            if let Some(client) = client_rect(window.hwnd) {
                return MonitorFromRect(&win_rect(client), MONITOR_DEFAULTTOPRIMARY);
            }
        }
        MonitorFromWindow(0, MONITOR_DEFAULTTOPRIMARY)
    }
}

pub fn launch_viewport() -> Result<crate::cs2_video::VideoSize, String> {
    let _coordinates = PhysicalCoordinates::enter();
    let area = monitor_layout_area(choose_monitor(None), true).ok_or("无法读取显示器尺寸，未修改游戏配置。")?;
    let game = workspace_layout(area).game;
    crate::cs2_video::VideoSize::new(game.width, game.height)
}

pub fn outer_from_client(client: Rect, frame: Rect) -> Rect {
    Rect { x: client.x + frame.x, y: client.y + frame.y, width: client.width + frame.width, height: client.height + frame.height }
}

fn align_cs2(window: Cs2Window, target: Rect) -> bool {
    unsafe {
        if IsIconic(window.hwnd) != 0 { return false; }
        let style = GetWindowLongW(window.hwnd, -16) as u32;
        let ex_style = GetWindowLongW(window.hwnd, -20) as u32;
        let dpi = GetDpiForWindow(window.hwnd);
        if dpi == 0 { return false; }
        let mut border = WinRect::default();
        border.right = target.width;
        border.bottom = target.height;
        if AdjustWindowRectExForDpi(&mut border, style, 0, ex_style, dpi) == 0 { return false; }
        let frame = Rect { x: border.left, y: border.top, width: border.right - border.left - target.width, height: border.bottom - border.top - target.height };
        let outer = outer_from_client(target, frame);
        if SetWindowPos(window.hwnd, 0, outer.x, outer.y, outer.width, outer.height, SWP_NOZORDER | SWP_NOACTIVATE) == 0 { return false; }
        let Some(actual) = client_rect(window.hwnd) else { return false; };
        if actual == target { return true; }
        // CS2 can keep its launch-time render client despite accepting the outer
        // window resize. Shrinking a borderless outer a second time crops it;
        // it cannot change the engine's video mode. Keep the intended viewport.
        if frame.width == 0 && frame.height == 0 { return false; }
        let correction = Rect {
            x: outer.x + target.x - actual.x,
            y: outer.y + target.y - actual.y,
            width: outer.width + target.width - actual.width,
            height: outer.height + target.height - actual.height,
        };
        if SetWindowPos(window.hwnd, 0, correction.x, correction.y, correction.width, correction.height, SWP_NOZORDER | SWP_NOACTIVATE) == 0 { return false; }
        client_rect(window.hwnd).is_some_and(|measured| overlap(measured, target) == (target.width as i64 * target.height as i64) && measured.width == target.width && measured.height == target.height)
    }
}

#[derive(Default)]
pub struct GameTracker {
    pub window: Option<Cs2Window>,
    pub generation: u64,
    monitor: Monitor,
    pub managed: bool,
    pub preserve_settings: bool,
    pub overlay_enabled: bool,
    pub fullscreen_layout: bool,
    frame: Option<crate::window_frame::GameFrame>,
    last_client: Option<Rect>,
    last_work_area: Option<Rect>,
    last_dpi: u32,
    alignment_retries: u8,
    last_alignment: Option<std::time::Instant>,
}

impl GameTracker {
    pub fn geometry_diagnostics(&self) -> serde_json::Value {
        let _coordinates = PhysicalCoordinates::enter();
        let Some(window) = self.window else { return serde_json::Value::Null; };
        let mut size = WinRect::default();
        let mut outer = WinRect::default();
        let mut origin = Point::default();
        unsafe {
            if GetClientRect(window.hwnd, &mut size) == 0 || GetWindowRect(window.hwnd, &mut outer) == 0 || ClientToScreen(window.hwnd, &mut origin) == 0 { return serde_json::Value::Null; }
            let mut end = Point { x: size.right, y: size.bottom };
            let end_valid = ClientToScreen(window.hwnd, &mut end) != 0;
            serde_json::json!({
                "dpi": GetDpiForWindow(window.hwnd),
                "clientSize": [size.right, size.bottom],
                "screenOrigin": [origin.x, origin.y],
                "screenEnd": end_valid.then_some([end.x, end.y]),
                "outer": [outer.left, outer.top, outer.right, outer.bottom],
                "alignmentRetries": self.alignment_retries
            })
        }
    }
    pub fn observe(&mut self, found: Option<Cs2Window>) -> bool {
        if self.window == found { return false; }
        self.frame = None;
        self.window = found;
        self.generation += 1;
        self.managed = false;
        self.last_client = None;
        self.last_dpi = 0;
        self.alignment_retries = 30;
        self.last_alignment = None;
        true
    }
    fn observe_target(&mut self, found: Option<Cs2Window>, monitor: Monitor) -> bool {
        let changed = self.observe(found);
        let moved = self.monitor != monitor;
        self.monitor = monitor;
        changed || moved
    }
    fn refresh_target(&mut self) -> bool {
        let found = find_cs2();
        self.observe_target(found, choose_monitor(found))
    }
    pub fn restore_layout(&mut self) -> Option<Layout> {
        let _coordinates = PhysicalCoordinates::enter();
        self.refresh_target();
        self.alignment_retries = 30;
        self.apply_locked_layout()
    }
    fn apply_locked_layout(&mut self) -> Option<Layout> {
        let work = monitor_layout_area(self.monitor, self.fullscreen_layout)?;
        self.last_work_area = Some(work);
        let mut layout = workspace_layout(work);
        if self.preserve_settings {
            self.managed = false;
            self.alignment_retries = 0;
            self.last_client = self.window.and_then(|window| client_rect(window.hwnd));
            return Some(layout);
        }
        if let Some(window) = self.window {
            if self.frame.is_none() {
                self.frame = crate::window_frame::GameFrame::capture(window.hwnd, window.pid);
            }
            if let Some(frame) = &self.frame { frame.apply(); }
        }
        self.managed = self.window.is_some_and(|window| align_cs2(window, layout.game));
        if let Some(window) = self.window.filter(|_| self.managed) {
            let mut outer = WinRect::default();
            if unsafe { GetWindowRect(window.hwnd, &mut outer) } != 0 {
                layout = avoid_game_frame(layout, rect(outer));
            }
        }
        self.alignment_retries = self.alignment_retries.saturating_sub(1);
        self.last_alignment = Some(std::time::Instant::now());
        self.last_client = self.window.and_then(|window| client_rect(window.hwnd));
        self.last_dpi = self.window.map_or(0, |window| unsafe { GetDpiForWindow(window.hwnd) });
        Some(layout)
    }
    pub fn tick(&mut self) -> Option<Layout> {
        let _coordinates = PhysicalCoordinates::enter();
        let changed = self.refresh_target();
        let work = monitor_layout_area(self.monitor, self.fullscreen_layout);
        if self.monitor == 0 || work.is_none() {
            return self.restore_layout();
        }
        if work != self.last_work_area { return self.restore_layout(); }
        if changed { return self.apply_locked_layout(); }
        let Some(window) = self.window else { return None; };
        // CS2 can reject an early resize while constructing its render window.
        // Retry on a bounded cadence; do not continuously fight user settings.
        if !self.managed && self.alignment_retries > 0 && self.last_alignment.is_none_or(|at| at.elapsed() >= std::time::Duration::from_secs(1)) {
            return self.apply_locked_layout();
        }
        let client = client_rect(window.hwnd);
        let dpi = unsafe { GetDpiForWindow(window.hwnd) };
        if client != self.last_client || dpi != self.last_dpi {
            self.last_client = client;
            self.last_dpi = dpi;
            if self.managed {
                return self.apply_locked_layout();
            }
        }
        None
    }
    pub fn overlay_rect(&self) -> Option<Rect> {
        let _coordinates = PhysicalCoordinates::enter();
        let window = self.window?;
        let client = client_rect(window.hwnd)?;
        let mut foreground_pid = 0;
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut foreground_pid); }
        let foreground_owned = foreground_pid == window.pid || foreground_pid == std::process::id();
        overlay_visible(!self.preserve_settings && self.managed && self.overlay_enabled, unsafe { IsIconic(window.hwnd) != 0 }, client, foreground_owned).then_some(client)
    }
    pub fn restore_focus(&self) -> bool {
        self.window.is_some_and(|window| unsafe { IsWindow(window.hwnd) != 0 && SetForegroundWindow(window.hwnd) != 0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_and_generation() {
        let client = Rect { x: 100, y: 80, width: 1440, height: 810 };
        let frame = Rect { x: -8, y: -31, width: 16, height: 39 };
        assert_eq!(outer_from_client(client, frame), Rect { x: 92, y: 49, width: 1456, height: 849 });
        let mut tracker = GameTracker::default();
        assert!(tracker.observe(Some(Cs2Window { pid: 42, hwnd: 7 })));
        assert_eq!(tracker.generation, 1);
        assert!(!tracker.observe(Some(Cs2Window { pid: 42, hwnd: 7 })));
        assert!(tracker.observe(None));
        assert_eq!(tracker.generation, 2);
        tracker.monitor = 42;
        assert!(tracker.observe(Some(Cs2Window { pid: 43, hwnd: 8 })));
        assert_eq!(tracker.monitor, 42);
    }
    #[test]
    fn discovers_secondary_monitor_before_layout_and_reselects_on_move() {
        let game = Cs2Window { pid: 42, hwnd: 7 };
        let mut tracker = GameTracker::default();
        assert!(tracker.observe_target(Some(game), 2));
        assert_eq!(tracker.window, Some(game));
        assert_eq!(tracker.monitor, 2);
        assert!(!tracker.observe_target(Some(game), 2));
        assert!(tracker.observe_target(Some(game), 3));
        assert_eq!(tracker.monitor, 3);
        assert_eq!(tracker.generation, 1);
        let replacement = Cs2Window { pid: 43, hwnd: 8 };
        assert!(tracker.observe_target(Some(replacement), 4));
        assert_eq!(tracker.monitor, 4);
        assert_eq!(tracker.generation, 2);
    }
    #[test]
    fn late_game_discovery_replaces_primary_monitor_fallback() {
        let mut tracker = GameTracker::default();
        assert!(tracker.observe_target(None, 1));
        assert!(tracker.observe_target(Some(Cs2Window { pid: 42, hwnd: 7 }), 2));
        assert_eq!(tracker.monitor, 2);
    }
}
