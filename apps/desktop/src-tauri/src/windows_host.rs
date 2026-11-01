use crate::geometry::{avoid_game_frame, overlay_visible, workspace_layout, Layout, Rect};

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() }
}

type Hwnd = isize;
type Monitor = isize;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: WinRect,
    work: WinRect,
    flags: u32,
}

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
    fn GetWindow(hwnd: Hwnd, command: u32) -> Hwnd;
    fn GetDpiForWindow(hwnd: Hwnd) -> u32;
    fn SetThreadDpiAwarenessContext(context: isize) -> isize;
    fn AdjustWindowRectExForDpi(
        rect: *mut WinRect,
        style: u32,
        menu: i32,
        ex_style: u32,
        dpi: u32,
    ) -> i32;
    fn SetWindowPos(
        hwnd: Hwnd,
        after: Hwnd,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: u32,
    ) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn SetForegroundWindow(hwnd: Hwnd) -> i32;
    fn MonitorFromRect(rect: *const WinRect, flags: u32) -> Monitor;
    fn MonitorFromWindow(hwnd: Hwnd, flags: u32) -> Monitor;
    fn GetMonitorInfoW(monitor: Monitor, info: *mut MonitorInfo) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn QueryFullProcessImageNameW(
        process: isize,
        flags: u32,
        buffer: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
    fn GetTokenInformation(
        token: isize,
        class: u32,
        value: *mut u32,
        size: u32,
        length: *mut u32,
    ) -> i32;
}
fn process_elevation(pid: u32) -> serde_json::Value {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process == 0 {
            return serde_json::json!({"elevated": null, "lastError": std::io::Error::last_os_error().raw_os_error()});
        }
        let mut token = 0;
        let opened = OpenProcessToken(process, 8, &mut token);
        let open_error = if opened == 0 {
            std::io::Error::last_os_error().raw_os_error()
        } else {
            None
        };
        CloseHandle(process);
        if opened == 0 {
            return serde_json::json!({"elevated": null, "lastError": open_error});
        }
        let mut elevated = 0;
        let mut length = 0;
        let read = GetTokenInformation(token, 20, &mut elevated, 4, &mut length);
        let error = if read == 0 {
            std::io::Error::last_os_error().raw_os_error()
        } else {
            None
        };
        CloseHandle(token);
        serde_json::json!({"elevated": if read != 0 { Some(elevated != 0) } else { None }, "lastError": error})
    }
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const MONITOR_DEFAULTTOPRIMARY: u32 = 1;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_ASYNCWINDOWPOS: u32 = 0x4000;

// The tracker runs both on the Host worker and command dispatcher. Win32
// otherwise virtualizes coordinates differently from Tauri's physical pixels.
struct PhysicalCoordinates(isize);
impl PhysicalCoordinates {
    fn enter() -> Self {
        Self(unsafe { SetThreadDpiAwarenessContext(-4) })
    }
}
impl Drop for PhysicalCoordinates {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }
}

fn rect(value: WinRect) -> Rect {
    Rect {
        x: value.left,
        y: value.top,
        width: value.right - value.left,
        height: value.bottom - value.top,
    }
}
fn win_rect(value: Rect) -> WinRect {
    WinRect {
        left: value.x,
        top: value.y,
        right: value.right(),
        bottom: value.bottom(),
    }
}

fn is_cs2(pid: u32) -> bool {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process == 0 {
            return false;
        }
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let found = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        found != 0
            && String::from_utf16_lossy(&buffer[..length as usize])
                .to_ascii_lowercase()
                .ends_with("\\cs2.exe")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cs2Window {
    pub pid: u32,
    pub hwnd: isize,
}

unsafe extern "system" fn collect_window(hwnd: Hwnd, data: isize) -> i32 {
    if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
        return 1;
    }
    // Owned dialogs and tool windows are not the game's rendering surface.
    if GetWindow(hwnd, 4) != 0 || (GetWindowLongW(hwnd, -20) as u32 & 0x80) != 0 {
        return 1;
    }
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
    unsafe {
        EnumWindows(collect_window, &mut windows as *mut _ as isize);
    }
    windows.into_iter().next()
}

pub fn window_exists(hwnd: Hwnd) -> bool {
    unsafe { IsWindow(hwnd) != 0 }
}

pub fn client_rect(hwnd: Hwnd) -> Option<Rect> {
    unsafe {
        if IsWindow(hwnd) == 0 {
            return None;
        }
        let mut size = WinRect::default();
        let mut origin = Point::default();
        if GetClientRect(hwnd, &mut size) == 0 || ClientToScreen(hwnd, &mut origin) == 0 {
            return None;
        }
        let result = Rect {
            x: origin.x,
            y: origin.y,
            width: size.right,
            height: size.bottom,
        };
        (result.width > 0 && result.height > 0).then_some(result)
    }
}

fn monitor_layout_area(monitor: Monitor, fullscreen: bool) -> Option<Rect> {
    unsafe {
        let mut info = MonitorInfo {
            size: std::mem::size_of::<MonitorInfo>() as u32,
            monitor: WinRect::default(),
            work: WinRect::default(),
            flags: 0,
        };
        (monitor != 0 && GetMonitorInfoW(monitor, &mut info) != 0)
            .then(|| rect(if fullscreen { info.monitor } else { info.work }))
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
    let area = monitor_layout_area(choose_monitor(None), true)
        .ok_or("无法读取显示器尺寸，未修改游戏配置。")?;
    let game = workspace_layout(area).game;
    crate::cs2_video::VideoSize::new(game.width, game.height)
}

pub fn outer_from_client(client: Rect, frame: Rect) -> Rect {
    Rect {
        x: client.x + frame.x,
        y: client.y + frame.y,
        width: client.width + frame.width,
        height: client.height + frame.height,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AlignmentFailure {
    pub stage: &'static str,
    pub api: Option<&'static str>,
    pub last_error: Option<u32>,
}
impl AlignmentFailure {
    fn win32(stage: &'static str, api: &'static str) -> Self {
        Self {
            stage,
            api: Some(api),
            last_error: std::io::Error::last_os_error()
                .raw_os_error()
                .map(|code| code as u32),
        }
    }
    pub fn diagnostic(self) -> serde_json::Value {
        serde_json::json!({"stage": self.stage, "api": self.api, "lastError": self.last_error, "target": "game"})
    }
    pub fn message(self) -> String {
        let phase = match self.stage {
            "measure" | "empty_client" => "画面范围读取",
            "dpi" => "显示缩放读取",
            "frame" => "边框尺寸计算",
            "correction" => "尺寸修正",
            _ => "定位",
        };
        if self.last_error == Some(5) {
            return format!("CS2 窗口{phase}被系统拒绝。请核对 Mizar 与 Steam／CS2 的运行权限，再点恢复布局；仍失败时正常退出本次游戏，在准备中心重试恢复，备份与错误记录会保留。");
        }
        match self.stage {
            "pending" => "布局请求已提交，正在等待 CS2 窗口对齐。".into(),
            "client_mismatch" => "CS2 窗口已接受定位，但实际画面范围与工作台不一致。请先点恢复布局；仍不一致时正常退出本次游戏，在准备中心完成恢复后按当前屏幕重新启动。".into(),
            "minimized" => "CS2 已最小化，尚未对齐。请还原游戏窗口，再点恢复布局。".into(),
            _ => format!("CS2 窗口{phase}未完成。请确认游戏窗口可见，再点恢复布局；仍失败时正常退出本次游戏，在准备中心重试恢复，备份与错误记录会保留。"),
        }
    }
}

fn measured_client(hwnd: Hwnd) -> Result<Rect, AlignmentFailure> {
    unsafe {
        let mut size = WinRect::default();
        let mut origin = Point::default();
        if GetClientRect(hwnd, &mut size) == 0 {
            return Err(AlignmentFailure::win32("measure", "GetClientRect"));
        }
        if ClientToScreen(hwnd, &mut origin) == 0 {
            return Err(AlignmentFailure::win32("measure", "ClientToScreen"));
        }
        if size.right <= 0 || size.bottom <= 0 {
            return Err(AlignmentFailure {
                stage: "empty_client",
                api: None,
                last_error: None,
            });
        }
        Ok(Rect {
            x: origin.x,
            y: origin.y,
            width: size.right,
            height: size.bottom,
        })
    }
}

fn align_cs2(window: Cs2Window, target: Rect, correcting: bool) -> Result<(), AlignmentFailure> {
    unsafe {
        if IsIconic(window.hwnd) != 0 {
            return Err(AlignmentFailure {
                stage: "minimized",
                api: None,
                last_error: None,
            });
        }
        let style = GetWindowLongW(window.hwnd, -16) as u32;
        let ex_style = GetWindowLongW(window.hwnd, -20) as u32;
        let dpi = GetDpiForWindow(window.hwnd);
        if dpi == 0 {
            return Err(AlignmentFailure {
                stage: "dpi",
                api: Some("GetDpiForWindow"),
                last_error: None,
            });
        }
        let mut border = WinRect::default();
        border.right = target.width;
        border.bottom = target.height;
        if AdjustWindowRectExForDpi(&mut border, style, 0, ex_style, dpi) == 0 {
            return Err(AlignmentFailure::win32("frame", "AdjustWindowRectExForDpi"));
        }
        let frame = Rect {
            x: border.left,
            y: border.top,
            width: border.right - border.left - target.width,
            height: border.bottom - border.top - target.height,
        };
        let actual = measured_client(window.hwnd)?;
        if actual == target {
            return Ok(());
        }
        let mut outer = outer_from_client(target, frame);
        if correcting && (frame.width != 0 || frame.height != 0) {
            let mut current = WinRect::default();
            if GetWindowRect(window.hwnd, &mut current) != 0 {
                let current = rect(current);
                outer = Rect {
                    x: current.x + target.x - actual.x,
                    y: current.y + target.y - actual.y,
                    width: current.width + target.width - actual.width,
                    height: current.height + target.height - actual.height,
                };
            }
        }
        if SetWindowPos(
            window.hwnd,
            0,
            outer.x,
            outer.y,
            outer.width,
            outer.height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        ) == 0
        {
            return Err(AlignmentFailure::win32("position", "SetWindowPos"));
        }
        // The target thread may not have processed the request yet. Only a
        // later measurement can establish that the game actually aligned.
        Err(AlignmentFailure {
            stage: "pending",
            api: None,
            last_error: None,
        })
    }
}

#[derive(Default)]
pub struct GameTracker {
    owner: Option<crate::managed_cs2::WorkspaceProcess>,
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
    pub alignment_failure: Option<AlignmentFailure>,
    reported_alignment_failure: Option<AlignmentFailure>,
    pub group_failure: Option<crate::workspace_group::Failure>,
}

impl GameTracker {
    pub fn owned_window(&self) -> Option<Cs2Window> {
        let window = self.window?;
        let owner = self.owner.as_ref()?;
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(window.hwnd, &mut pid);
        }
        (owner.is_running() && owner.pid == window.pid && pid == window.pid).then_some(window)
    }
    pub fn set_owner(&mut self, owner: Option<crate::managed_cs2::WorkspaceProcess>) {
        self.owner = owner.filter(|process| process.is_running());
    }
    pub fn finish_session_feedback(
        &mut self,
        cs2: &crate::managed_cs2::ManagedCs2,
    ) -> Result<bool, String> {
        if self.window.is_none() && self.alignment_failure.is_none() && self.group_failure.is_none()
        {
            return Ok(false);
        }
        if !cs2.window_session_finished()? {
            return Ok(false);
        }
        self.observe(None);
        // Hidden panels may already have no HWND yet retain the last failure.
        self.alignment_failure = None;
        self.reported_alignment_failure = None;
        self.group_failure = None;
        self.managed = false;
        Ok(true)
    }
    pub fn alignment_event(&mut self) -> Option<AlignmentFailure> {
        let changed = self.alignment_failure != self.reported_alignment_failure;
        self.reported_alignment_failure = self.alignment_failure;
        changed.then_some(self.alignment_failure).flatten()
    }
    pub fn window_message(&self) -> Option<String> {
        self.alignment_failure
            .map(AlignmentFailure::message)
            .or_else(|| {
                self.group_failure
                    .map(crate::workspace_group::Failure::message)
            })
    }
    pub fn geometry_diagnostics(&self) -> serde_json::Value {
        let _coordinates = PhysicalCoordinates::enter();
        let area = |value: Rect| [value.x, value.y, value.width, value.height];
        let monitor_bounds = monitor_layout_area(self.monitor, true);
        let work_area = monitor_layout_area(self.monitor, false);
        let layout_area = self.last_work_area;
        let target = layout_area.map(|work| workspace_layout(work).game);
        let client = self.window.and_then(|window| client_rect(window.hwnd));
        let outer = self.window.and_then(|window| unsafe {
            let mut value = WinRect::default();
            (GetWindowRect(window.hwnd, &mut value) != 0).then(|| rect(value))
        });
        serde_json::json!({
            "dpi": self.window.map(|window| unsafe { GetDpiForWindow(window.hwnd) }).filter(|dpi| *dpi != 0),
            "client": client.map(area), "outer": outer.map(area),
            "monitorBounds": monitor_bounds.map(area), "workArea": work_area.map(area),
            "layoutArea": layout_area.map(area), "target": target.map(area),
            "alignmentRetries": self.alignment_retries,
            "preserveSettings": self.preserve_settings,
            "fullscreenLayout": self.fullscreen_layout,
            "alignmentFailure": self.alignment_failure.map(AlignmentFailure::diagnostic),
            "groupFailure": self.group_failure.map(crate::workspace_group::Failure::diagnostic),
            "hostElevation": process_elevation(std::process::id()),
            "gameElevation": self.window.map(|window| process_elevation(window.pid))
        })
    }
    pub fn observe(&mut self, found: Option<Cs2Window>) -> bool {
        if self.window == found {
            return false;
        }
        self.frame = None;
        self.window = found;
        self.generation += 1;
        self.managed = false;
        self.alignment_failure = None;
        self.reported_alignment_failure = None;
        self.group_failure = None;
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
        // Minimization is not a game/window replacement. Keep the measured
        // monitor and frame lease until the same HWND is restored or destroyed.
        if self.window.is_some_and(|window| {
            self.owner
                .as_ref()
                .is_some_and(|owner| owner.is_running() && owner.pid == window.pid)
                && unsafe {
                    let mut pid = 0;
                    GetWindowThreadProcessId(window.hwnd, &mut pid);
                    pid == window.pid && IsIconic(window.hwnd) != 0
                }
        }) {
            return false;
        }
        let found = find_cs2().filter(|window| {
            self.owner
                .as_ref()
                .is_some_and(|owner| owner.is_running() && owner.pid == window.pid)
        });
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
        let correcting = self.last_work_area == Some(work)
            && self
                .alignment_failure
                .is_some_and(|failure| failure.stage == "pending");
        self.last_work_area = Some(work);
        let mut layout = workspace_layout(work);
        if self.preserve_settings {
            self.managed = false;
            self.alignment_retries = 0;
            self.alignment_failure = None;
            self.last_client = self.window.and_then(|window| client_rect(window.hwnd));
            return Some(layout);
        }
        if let Some(window) = self.window {
            if self.frame.is_none() {
                self.frame = crate::window_frame::GameFrame::capture(window.hwnd, window.pid);
            }
            if let Some(frame) = &self.frame {
                frame.apply();
            }
        }
        let alignment = self
            .window
            .map(|window| align_cs2(window, layout.game, correcting));
        self.managed = matches!(alignment, Some(Ok(())));
        self.alignment_failure = alignment.and_then(Result::err);
        if let Some(window) = self.window.filter(|_| self.managed) {
            let mut outer = WinRect::default();
            if unsafe { GetWindowRect(window.hwnd, &mut outer) } != 0 {
                layout = avoid_game_frame(layout, rect(outer));
            }
        }
        self.alignment_retries = self.alignment_retries.saturating_sub(1);
        if self.alignment_retries == 0
            && self
                .alignment_failure
                .is_some_and(|failure| failure.stage == "pending")
        {
            self.alignment_failure = Some(AlignmentFailure {
                stage: "client_mismatch",
                api: None,
                last_error: None,
            });
        }
        self.last_alignment = Some(std::time::Instant::now());
        self.last_client = self.window.and_then(|window| client_rect(window.hwnd));
        self.last_dpi = self
            .window
            .map_or(0, |window| unsafe { GetDpiForWindow(window.hwnd) });
        Some(layout)
    }
    pub fn tick(&mut self) -> Option<Layout> {
        let _coordinates = PhysicalCoordinates::enter();
        let changed = self.refresh_target();
        if self
            .window
            .is_some_and(|window| unsafe { IsIconic(window.hwnd) != 0 })
        {
            return None;
        }
        let work = monitor_layout_area(self.monitor, self.fullscreen_layout);
        if self.monitor == 0 || work.is_none() {
            return self.restore_layout();
        }
        if work != self.last_work_area {
            return self.restore_layout();
        }
        if changed {
            return self.apply_locked_layout();
        }
        let Some(window) = self.window else {
            return None;
        };
        // CS2 can reject an early resize while constructing its render window.
        // Retry on a bounded cadence; do not continuously fight user settings.
        if !self.managed
            && self.alignment_retries > 0
            && self
                .last_alignment
                .is_none_or(|at| at.elapsed() >= std::time::Duration::from_secs(1))
        {
            return self.apply_locked_layout();
        }
        let client = client_rect(window.hwnd);
        let dpi = unsafe { GetDpiForWindow(window.hwnd) };
        let recovered = alignment_geometry_recovered(self.last_client, self.last_dpi, client, dpi);
        if client != self.last_client || dpi != self.last_dpi {
            self.last_client = client;
            self.last_dpi = dpi;
            if self.managed {
                return self.apply_locked_layout();
            }
            // A failed DPI/client query can outlive the startup retry window.
            // Re-arm only when unavailable geometry becomes valid, not on user resizing.
            if !self.preserve_settings && self.alignment_failure.is_some() && recovered {
                self.alignment_retries = 30;
                return self.apply_locked_layout();
            }
        }
        None
    }
    /// Cheap final check on the UI thread after a worker computed the rectangle.
    pub fn overlay_still_allowed(&self, panels: &[isize]) -> bool {
        self.window.is_some_and(|game| {
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(game.hwnd, &mut pid);
            }
            pid == game.pid
                && !self.preserve_settings
                && self.managed
                && self.overlay_enabled
                && unsafe { IsWindow(game.hwnd) != 0 && IsIconic(game.hwnd) == 0 }
                && overlay_foreground_allowed(foreground(), game.hwnd, panels)
        })
    }
    pub fn overlay_rect(&self, workspace_windows: &[isize]) -> Option<Rect> {
        let _coordinates = PhysicalCoordinates::enter();
        let window = self.owned_window()?;
        let client = client_rect(window.hwnd)?;
        let foreground = unsafe { GetForegroundWindow() };
        let foreground_allowed =
            overlay_foreground_allowed(foreground, window.hwnd, workspace_windows);
        overlay_visible(
            !self.preserve_settings && self.managed && self.overlay_enabled,
            unsafe { IsIconic(window.hwnd) != 0 },
            client,
            foreground_allowed,
        )
        .then_some(client)
    }
    pub fn restore_focus(&self, source: isize) -> bool {
        self.owned_window().is_some_and(|window| unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(window.hwnd, &mut pid);
            pid == window.pid
                && IsWindow(window.hwnd) != 0
                && source != 0
                && GetForegroundWindow() == source
                && SetForegroundWindow(window.hwnd) != 0
                && GetForegroundWindow() == window.hwnd
        })
    }
}

/// Compare only the two known windows; do not record intervening window identities.
pub fn overlay_diagnostic(
    overlay: isize,
    game: Option<isize>,
    panels: &[isize],
) -> serde_json::Value {
    let foreground = unsafe { GetForegroundWindow() };
    let role = if Some(foreground) == game {
        "game"
    } else if panels.contains(&foreground) {
        "workspace"
    } else if foreground == overlay {
        "overlay"
    } else {
        "other"
    };
    let mut rect = WinRect::default();
    let rect_ok = unsafe { GetWindowRect(overlay, &mut rect) } != 0;
    let topmost = unsafe { GetWindowLongW(overlay, -20) } & 0x00000008 != 0;
    let above_game = game.and_then(|game| {
        if unsafe { IsWindow(overlay) } == 0 || unsafe { IsWindow(game) } == 0 {
            return None;
        }
        let mut next = overlay;
        for _ in 0..512 {
            next = unsafe { GetWindow(next, 2) }; // GW_HWNDNEXT
            if next == game {
                return Some(true);
            }
            if next == 0 {
                return Some(false);
            }
        }
        None
    });
    serde_json::json!({"visible": unsafe { IsWindowVisible(overlay) } != 0,
        "rect": rect_ok.then_some([rect.left, rect.top, rect.right, rect.bottom]),
        "topmost": topmost, "foregroundRole": role, "aboveGame": above_game})
}

fn overlay_foreground_allowed(foreground: isize, game: isize, workspace_windows: &[isize]) -> bool {
    foreground != 0 && (foreground == game || workspace_windows.contains(&foreground))
}

fn alignment_geometry_recovered(
    previous: Option<Rect>,
    previous_dpi: u32,
    current: Option<Rect>,
    dpi: u32,
) -> bool {
    (previous.is_none() || previous_dpi == 0) && current.is_some() && dpi != 0
}
