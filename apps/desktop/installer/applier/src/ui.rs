use mizar_common::{to_wide, UPDATE_WINDOW_CLASS, UPDATE_WINDOW_TITLE};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

const WM_DESTROY: u32 = 0x0002;
const WM_PAINT: u32 = 0x000F;
const WM_CLOSE: u32 = 0x0010;
const WM_ERASEBKGND: u32 = 0x0014;
const WM_SYSCOLORCHANGE: u32 = 0x0015;
const WM_SETTINGCHANGE: u32 = 0x001A;
const WM_SETFONT: u32 = 0x0030;
const WM_SETICON: u32 = 0x0080;
const WM_COMMAND: u32 = 0x0111;
const WM_TIMER: u32 = 0x0113;
const WM_CTLCOLORBTN: u32 = 0x0135;
const WM_DPICHANGED: u32 = 0x02E0;
const WM_PRINTCLIENT: u32 = 0x0318;
const WM_APP_SYNC: u32 = 0x8001;
const WM_APP_CLOSE: u32 = 0x8002;

const WS_OVERLAPPED: u32 = 0x0000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_SYSMENU: u32 = 0x0008_0000;
const WS_CLIPCHILDREN: u32 = 0x0200_0000;
const WS_CHILD: u32 = 0x4000_0000;
const WS_TABSTOP: u32 = 0x0001_0000;
const BS_PUSHBUTTON: u32 = 0x0000_0000;
const BS_DEFPUSHBUTTON: u32 = 0x0000_0001;
const WINDOW_STYLE: u32 = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;

const SW_HIDE: i32 = 0;
const SW_SHOW: i32 = 5;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;

const IDC_CLOSE: usize = 1; // IDOK
const IDC_CANCEL: usize = 2; // IDCANCEL
const IDC_OPEN_LOGS: usize = 1002;

const TIMER_ANIM_ID: usize = 1;
const TIMER_PREVIEW_ID: usize = 2;

const ICON_SMALL: usize = 0;
const ICON_BIG: usize = 1;
const IMAGE_ICON: u32 = 1;
const LR_DEFAULTCOLOR: u32 = 0;
const DI_NORMAL: u32 = 0x0003;

const SC_CLOSE: u32 = 0xF060;
const MF_BYCOMMAND: u32 = 0x0000;
const MF_ENABLED: u32 = 0x0000;
const MF_GRAYED: u32 = 0x0001;

const SPI_GETWORKAREA: u32 = 0x0030;
const SPI_GETHIGHCONTRAST: u32 = 0x0042;
const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
const HCF_HIGHCONTRASTON: u32 = 0x0001;

const COLOR_WINDOW: i32 = 5;
const COLOR_WINDOWTEXT: i32 = 8;
const COLOR_HIGHLIGHT: i32 = 13;
const COLOR_BTNSHADOW: i32 = 16;
const COLOR_GRAYTEXT: i32 = 17;

const TRANSPARENT: i32 = 1;
const PS_SOLID: i32 = 0;
const PS_NULL: i32 = 5;
const SRCCOPY: u32 = 0x00CC_0020;
const CLEARTYPE_QUALITY: u32 = 5;
const DEFAULT_CHARSET: u32 = 1;
const FW_NORMAL: i32 = 400;
const FW_SEMIBOLD: i32 = 600;

const DT_LEFT: u32 = 0x0000;
const DT_RIGHT: u32 = 0x0002;
const DT_VCENTER: u32 = 0x0004;
const DT_WORDBREAK: u32 = 0x0010;
const DT_SINGLELINE: u32 = 0x0020;
const DT_NOPREFIX: u32 = 0x0800;
const DT_END_ELLIPSIS: u32 = 0x8000;

const GWLP_USERDATA: i32 = -21;

const LOGICAL_W: i32 = 440;
const LOGICAL_H: i32 = 184;

const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
const DWMWA_USE_IMMERSIVE_DARK_MODE_OLD: u32 = 19;

// Graphite Instrument tokens (COLORREF = 0x00BB_GGRR)
const CLR_BG: u32 = 0x0020_1711; // #111720 bg.surface
const CLR_TRACK: u32 = 0x0026_1C16; // #161C26 bg.raised
const CLR_BORDER: u32 = 0x0041_3126; // #263141 border.default
const CLR_DIVIDER: u32 = 0x0036_271D; // #1D2736 subtle divider
const CLR_ACCENT: u32 = 0x00DF_7226; // #2672DF Mizar Blue
const CLR_DANGER: u32 = 0x0026_26DC; // #DC2626 error accent
const CLR_FG_PRIMARY: u32 = 0x00F9_F5F1; // #F1F5F9
const CLR_FG_SECONDARY: u32 = 0x00DB_CEC3; // #C3CEDB
const CLR_FG_MUTED: u32 = 0x00B8_A394; // #94A3B8

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum UiMode {
    Update,
    Install,
    Uninstall,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProgressKind {
    Indeterminate,
    Determinate { done: u64, total: u64 },
}

#[derive(Clone)]
struct ErrorView {
    heading: String,
    impact: String,
    detail: String,
    logs_dir: Option<PathBuf>,
}

struct SharedState {
    mode: UiMode,
    stage: String,
    version_label: Option<String>,
    progress: ProgressKind,
    committed: bool,
    cancelling: bool,
    error: Option<ErrorView>,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct PaintStruct {
    hdc: isize,
    f_erase: i32,
    rc_paint: Rect,
    f_restore: i32,
    f_inc_update: i32,
    rgb_reserved: [u8; 32],
}

#[repr(C)]
struct HighContrast {
    cb_size: u32,
    dw_flags: u32,
    lpsz_default_scheme: *mut u16,
}

#[repr(C)]
struct WndClassExW {
    cb_size: u32,
    style: u32,
    lpfn_wnd_proc: extern "system" fn(isize, u32, usize, isize) -> isize,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
    h_icon_sm: isize,
}

#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
}

#[repr(C)]
struct InitCommonControls {
    size: u32,
    icc: u32,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassExW(wc: *const WndClassExW) -> u16;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: *mut c_void,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
    fn IsDialogMessageW(hwnd: isize, msg: *const Msg) -> i32;
    fn TranslateMessage(msg: *const Msg) -> i32;
    fn DispatchMessageW(msg: *const Msg) -> isize;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn PostQuitMessage(exit_code: i32);
    fn DestroyWindow(hwnd: isize) -> i32;
    fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn UpdateWindow(hwnd: isize) -> i32;
    fn MoveWindow(hwnd: isize, x: i32, y: i32, w: i32, h: i32, repaint: i32) -> i32;
    fn SetWindowPos(
        hwnd: isize,
        insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn EnableWindow(hwnd: isize, enable: i32) -> i32;
    fn SetFocus(hwnd: isize) -> isize;
    fn SetTimer(hwnd: isize, id: usize, elapse: u32, func: *const c_void) -> usize;
    fn KillTimer(hwnd: isize, id: usize) -> i32;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, new_long: isize) -> isize;
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn BeginPaint(hwnd: isize, ps: *mut PaintStruct) -> isize;
    fn EndPaint(hwnd: isize, ps: *const PaintStruct) -> i32;
    fn InvalidateRect(hwnd: isize, rect: *const Rect, erase: i32) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
    fn DrawTextW(hdc: isize, text: *const u16, count: i32, rect: *mut Rect, format: u32) -> i32;
    fn FillRect(hdc: isize, rect: *const Rect, hbr: isize) -> i32;
    fn LoadImageW(
        hinst: isize,
        name: *const u16,
        img_type: u32,
        cx: i32,
        cy: i32,
        load: u32,
    ) -> isize;
    fn LoadCursorW(hinst: isize, name: *const u16) -> isize;
    fn DestroyIcon(hicon: isize) -> i32;
    fn DrawIconEx(
        hdc: isize,
        x: i32,
        y: i32,
        hicon: isize,
        cx: i32,
        cy: i32,
        step: u32,
        hbr: isize,
        flags: u32,
    ) -> i32;
    fn GetSystemMenu(hwnd: isize, revert: i32) -> isize;
    fn EnableMenuItem(hmenu: isize, item: u32, enable: u32) -> i32;
    fn GetDpiForWindow(hwnd: isize) -> u32;
    fn AdjustWindowRectExForDpi(
        rect: *mut Rect,
        style: u32,
        menu: i32,
        ex_style: u32,
        dpi: u32,
    ) -> i32;
    fn SystemParametersInfoW(action: u32, param: u32, pv_param: *mut c_void, win_ini: u32) -> i32;
    fn GetSysColor(index: i32) -> u32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strikeout: u32,
        charset: u32,
        out_prec: u32,
        clip_prec: u32,
        quality: u32,
        pitch: u32,
        face: *const u16,
    ) -> isize;
    fn CreateSolidBrush(color: u32) -> isize;
    fn CreatePen(style: i32, width: i32, color: u32) -> isize;
    fn SelectObject(hdc: isize, obj: isize) -> isize;
    fn DeleteObject(obj: isize) -> i32;
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn CreateCompatibleBitmap(hdc: isize, cx: i32, cy: i32) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
    fn BitBlt(
        dst: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        src: isize,
        sx: i32,
        sy: i32,
        rop: u32,
    ) -> i32;
    fn SetBkMode(hdc: isize, mode: i32) -> i32;
    fn SetTextColor(hdc: isize, color: u32) -> u32;
    fn RoundRect(hdc: isize, left: i32, top: i32, right: i32, bottom: i32, w: i32, h: i32) -> i32;
    fn MoveToEx(hdc: isize, x: i32, y: i32, pt: *mut c_void) -> i32;
    fn LineTo(hdc: isize, x: i32, y: i32) -> i32;
    fn SaveDC(hdc: isize) -> i32;
    fn RestoreDC(hdc: isize, saved: i32) -> i32;
    fn IntersectClipRect(hdc: isize, left: i32, top: i32, right: i32, bottom: i32) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[link(name = "comctl32")]
extern "system" {
    fn InitCommonControlsEx(picce: *const InitCommonControls) -> i32;
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attr: u32, pv_attr: *const c_void, cb_attr: u32) -> i32;
}

#[link(name = "uxtheme")]
extern "system" {
    fn SetWindowTheme(hwnd: isize, sub_app: *const u16, sub_id: *const u16) -> i32;
}

fn scale(v: i32, dpi: u32) -> i32 {
    (v * dpi as i32 + 48) / 96
}

fn is_high_contrast() -> bool {
    let mut hc = HighContrast {
        cb_size: std::mem::size_of::<HighContrast>() as u32,
        dw_flags: 0,
        lpsz_default_scheme: std::ptr::null_mut(),
    };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            hc.cb_size,
            (&mut hc as *mut HighContrast).cast(),
            0,
        )
    };
    ok != 0 && (hc.dw_flags & HCF_HIGHCONTRASTON) != 0
}

fn animations_enabled() -> bool {
    let mut enabled: i32 = 1;
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    ok == 0 || enabled != 0
}

struct Palette {
    high_contrast: bool,
    bg: u32,
    track: u32,
    border: u32,
    divider: u32,
    accent: u32,
    danger: u32,
    fg_primary: u32,
    fg_secondary: u32,
    fg_muted: u32,
}

impl Palette {
    fn current() -> Self {
        if is_high_contrast() {
            unsafe {
                let bg = GetSysColor(COLOR_WINDOW);
                let fg = GetSysColor(COLOR_WINDOWTEXT);
                let muted = GetSysColor(COLOR_GRAYTEXT);
                let accent = GetSysColor(COLOR_HIGHLIGHT);
                let border = GetSysColor(COLOR_BTNSHADOW);
                Self {
                    high_contrast: true,
                    bg,
                    track: bg,
                    border,
                    divider: border,
                    accent,
                    danger: accent,
                    fg_primary: fg,
                    fg_secondary: fg,
                    fg_muted: muted,
                }
            }
        } else {
            Self {
                high_contrast: false,
                bg: CLR_BG,
                track: CLR_TRACK,
                border: CLR_BORDER,
                divider: CLR_DIVIDER,
                accent: CLR_ACCENT,
                danger: CLR_DANGER,
                fg_primary: CLR_FG_PRIMARY,
                fg_secondary: CLR_FG_SECONDARY,
                fg_muted: CLR_FG_MUTED,
            }
        }
    }
}

fn make_font(px: i32, weight: i32) -> isize {
    let face = to_wide("Microsoft YaHei UI");
    unsafe {
        CreateFontW(
            -px,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            0,
            0,
            CLEARTYPE_QUALITY,
            0,
            face.as_ptr(),
        )
    }
}

fn load_app_icon(hinst: isize, size_px: i32) -> isize {
    unsafe {
        LoadImageW(
            hinst,
            1 as *const u16,
            IMAGE_ICON,
            size_px,
            size_px,
            LR_DEFAULTCOLOR,
        )
    }
}

fn apply_dark_chrome(hwnd: isize, high_contrast: bool) {
    let val: i32 = i32::from(!high_contrast);
    unsafe {
        let hr = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&val as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        if hr != 0 {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE_OLD,
                (&val as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

fn apply_button_theme(btn: isize, high_contrast: bool) {
    if btn == 0 {
        return;
    }
    if high_contrast {
        unsafe { SetWindowTheme(btn, std::ptr::null(), std::ptr::null()) };
    } else {
        let dark = to_wide("DarkMode_Explorer");
        unsafe { SetWindowTheme(btn, dark.as_ptr(), std::ptr::null()) };
    }
}

fn set_close_enabled(hwnd: isize, enabled: bool) {
    unsafe {
        let menu = GetSystemMenu(hwnd, 0);
        if menu != 0 {
            let flags = MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED };
            EnableMenuItem(menu, SC_CLOSE, flags);
        }
    }
}

struct WindowResources {
    dpi: u32,
    palette: Palette,
    bg_brush: isize,
    font_heading: isize,
    font_body: isize,
    font_small: isize,
    brand_icon: isize,
    icon_big: isize,
    icon_small: isize,
}

impl WindowResources {
    fn create(hinst: isize, dpi: u32) -> Self {
        let palette = Palette::current();
        let bg_brush = unsafe { CreateSolidBrush(palette.bg) };
        let font_heading = make_font(scale(16, dpi), FW_SEMIBOLD);
        let font_body = make_font(scale(13, dpi), FW_NORMAL);
        let font_small = make_font(scale(12, dpi), FW_NORMAL);
        let brand_icon = load_app_icon(hinst, scale(32, dpi));
        let icon_big = load_app_icon(hinst, scale(32, dpi));
        let icon_small = load_app_icon(hinst, scale(16, dpi));
        Self {
            dpi,
            palette,
            bg_brush,
            font_heading,
            font_body,
            font_small,
            brand_icon,
            icon_big,
            icon_small,
        }
    }

    fn destroy(&mut self) {
        unsafe {
            for obj in [
                self.bg_brush,
                self.font_heading,
                self.font_body,
                self.font_small,
            ] {
                if obj != 0 {
                    DeleteObject(obj);
                }
            }
            for icon in [self.brand_icon, self.icon_big, self.icon_small] {
                if icon != 0 {
                    DestroyIcon(icon);
                }
            }
        }
        self.bg_brush = 0;
        self.font_heading = 0;
        self.font_body = 0;
        self.font_small = 0;
        self.brand_icon = 0;
        self.icon_big = 0;
        self.icon_small = 0;
    }
}

struct WindowState {
    hinst: isize,
    res: WindowResources,
    cancel_hwnd: isize,
    logs_hwnd: isize,
    close_hwnd: isize,
    shared: Arc<Mutex<SharedState>>,
    cancelled: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
    anim_running: bool,
    anim_tick: u32,
    in_error_ui: bool,
}

impl WindowState {
    fn layout_controls(&self) {
        let d = self.res.dpi;
        let btn_y = scale(140, d);
        let btn_h = scale(32, d);
        unsafe {
            MoveWindow(
                self.cancel_hwnd,
                scale(332, d),
                btn_y,
                scale(84, d),
                btn_h,
                1,
            );
            MoveWindow(
                self.logs_hwnd,
                scale(208, d),
                btn_y,
                scale(112, d),
                btn_h,
                1,
            );
            MoveWindow(
                self.close_hwnd,
                scale(332, d),
                btn_y,
                scale(84, d),
                btn_h,
                1,
            );
            for btn in [self.cancel_hwnd, self.logs_hwnd, self.close_hwnd] {
                SendMessageW(btn, WM_SETFONT, self.res.font_body as usize, 1);
                apply_button_theme(btn, self.res.palette.high_contrast);
            }
        }
    }

    fn rebuild_resources(&mut self, hwnd: isize, new_dpi: u32) {
        self.res.destroy();
        self.res = WindowResources::create(self.hinst, new_dpi);
        apply_dark_chrome(hwnd, self.res.palette.high_contrast);
        unsafe {
            if self.res.icon_big != 0 {
                SendMessageW(hwnd, WM_SETICON, ICON_BIG, self.res.icon_big);
            }
            if self.res.icon_small != 0 {
                SendMessageW(hwnd, WM_SETICON, ICON_SMALL, self.res.icon_small);
            }
        }
        self.layout_controls();
    }

    fn sync_from_shared(&mut self, hwnd: isize) {
        let (mode, progress, committed, cancelling, error_view) = {
            let guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            (
                guard.mode,
                guard.progress,
                guard.committed,
                guard.cancelling,
                guard.error.clone(),
            )
        };

        let need_anim = error_view.is_none()
            && matches!(progress, ProgressKind::Indeterminate)
            && animations_enabled();
        if need_anim && !self.anim_running {
            unsafe { SetTimer(hwnd, TIMER_ANIM_ID, 33, std::ptr::null()) };
            self.anim_running = true;
        } else if !need_anim && self.anim_running {
            unsafe { KillTimer(hwnd, TIMER_ANIM_ID) };
            self.anim_running = false;
        }

        if let Some(err) = error_view {
            if !self.in_error_ui {
                self.in_error_ui = true;
                set_close_enabled(hwnd, true);
                unsafe {
                    ShowWindow(self.cancel_hwnd, SW_HIDE);
                    ShowWindow(
                        self.logs_hwnd,
                        if err.logs_dir.is_some() {
                            SW_SHOW
                        } else {
                            SW_HIDE
                        },
                    );
                    ShowWindow(self.close_hwnd, SW_SHOW);
                    SetFocus(self.close_hwnd);
                }
            }
        } else {
            let show_cancel = mode != UiMode::Uninstall;
            let can_cancel = show_cancel && !committed && !cancelling;
            set_close_enabled(hwnd, can_cancel);
            unsafe {
                ShowWindow(self.logs_hwnd, SW_HIDE);
                ShowWindow(self.close_hwnd, SW_HIDE);
                ShowWindow(
                    self.cancel_hwnd,
                    if show_cancel { SW_SHOW } else { SW_HIDE },
                );
                EnableWindow(self.cancel_hwnd, i32::from(can_cancel));
            }
        }

        unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
    }
}

fn draw_text(hdc: isize, font: isize, color: u32, text: &str, mut rect: Rect, flags: u32) {
    let wide = to_wide(text);
    unsafe {
        let prev = SelectObject(hdc, font);
        SetTextColor(hdc, color);
        DrawTextW(hdc, wide.as_ptr(), -1, &mut rect, flags | DT_NOPREFIX);
        SelectObject(hdc, prev);
    }
}

fn paint_window(hwnd: isize, target_hdc: isize, st: &WindowState) {
    let mut rc = Rect::default();
    unsafe { GetClientRect(hwnd, &mut rc) };
    let w = (rc.right - rc.left).max(1);
    let h = (rc.bottom - rc.top).max(1);

    let mem_dc = unsafe { CreateCompatibleDC(target_hdc) };
    let mem_bmp = unsafe { CreateCompatibleBitmap(target_hdc, w, h) };
    let old_bmp = unsafe { SelectObject(mem_dc, mem_bmp) };

    let d = st.res.dpi;
    let s = |v: i32| scale(v, d);
    let pal = &st.res.palette;

    unsafe {
        FillRect(mem_dc, &rc, st.res.bg_brush);
        SetBkMode(mem_dc, TRANSPARENT);
    }

    let (mode, stage, version_label, progress, committed, cancelling, error_view) = {
        let guard = st.shared.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.mode,
            guard.stage.clone(),
            guard.version_label.clone(),
            guard.progress,
            guard.committed,
            guard.cancelling,
            guard.error.clone(),
        )
    };

    if error_view.is_some() {
        let danger_brush = unsafe { CreateSolidBrush(pal.danger) };
        let strip = Rect {
            left: 0,
            top: 0,
            right: w,
            bottom: s(3).max(2),
        };
        unsafe {
            FillRect(mem_dc, &strip, danger_brush);
            DeleteObject(danger_brush);
        }
    }

    if st.res.brand_icon != 0 {
        unsafe {
            DrawIconEx(
                mem_dc,
                s(24),
                s(22),
                st.res.brand_icon,
                s(32),
                s(32),
                0,
                0,
                DI_NORMAL,
            );
        }
    }

    let heading = if let Some(ref err) = error_view {
        err.heading.as_str()
    } else {
        match mode {
            UiMode::Update => "正在更新 Mizar",
            UiMode::Install => "正在安装 Mizar",
            UiMode::Uninstall => "正在卸载 Mizar",
        }
    };

    let subtitle: Option<String> = if let Some(ref err) = error_view {
        Some(err.impact.clone())
    } else {
        match mode {
            UiMode::Uninstall => Some("你的配置与比赛资料将保留".to_string()),
            UiMode::Update | UiMode::Install => version_label,
        }
    };

    if let Some(sub) = subtitle {
        draw_text(
            mem_dc,
            st.res.font_heading,
            pal.fg_primary,
            heading,
            Rect {
                left: s(68),
                top: s(19),
                right: s(416),
                bottom: s(41),
            },
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
        );
        draw_text(
            mem_dc,
            st.res.font_small,
            pal.fg_muted,
            &sub,
            Rect {
                left: s(68),
                top: s(42),
                right: s(416),
                bottom: s(60),
            },
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
        );
    } else {
        draw_text(
            mem_dc,
            st.res.font_heading,
            pal.fg_primary,
            heading,
            Rect {
                left: s(68),
                top: s(27),
                right: s(416),
                bottom: s(49),
            },
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
        );
    }

    if let Some(ref err) = error_view {
        draw_text(
            mem_dc,
            st.res.font_body,
            pal.fg_secondary,
            &err.detail,
            Rect {
                left: s(24),
                top: s(70),
                right: s(416),
                bottom: s(120),
            },
            DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS,
        );
    } else {
        let pct_opt = match progress {
            ProgressKind::Determinate { done, total } if total > 0 => {
                Some(((done.saturating_mul(100)) / total).min(100))
            }
            _ => None,
        };
        let stage_right = if pct_opt.is_some() { s(350) } else { s(416) };
        draw_text(
            mem_dc,
            st.res.font_body,
            pal.fg_secondary,
            &stage,
            Rect {
                left: s(24),
                top: s(74),
                right: stage_right,
                bottom: s(94),
            },
            DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS,
        );
        if let Some(pct) = pct_opt {
            draw_text(
                mem_dc,
                st.res.font_small,
                pal.fg_muted,
                &format!("{pct}%"),
                Rect {
                    left: s(354),
                    top: s(75),
                    right: s(416),
                    bottom: s(94),
                },
                DT_RIGHT | DT_SINGLELINE,
            );
        }

        // Progress bar (6 logical px height)
        let bar_l = s(24);
        let bar_t = s(102);
        let bar_r = s(416);
        let bar_h = s(6).max(4);
        let bar_b = bar_t + bar_h;
        let bar_w = bar_r - bar_l;
        let radius = bar_h;

        unsafe {
            let track_pen = CreatePen(PS_SOLID, 1, pal.border);
            let track_brush = CreateSolidBrush(pal.track);
            let old_pen = SelectObject(mem_dc, track_pen);
            let old_brush = SelectObject(mem_dc, track_brush);
            RoundRect(mem_dc, bar_l, bar_t, bar_r, bar_b, radius, radius);
            SelectObject(mem_dc, old_pen);
            SelectObject(mem_dc, old_brush);
            DeleteObject(track_pen);
            DeleteObject(track_brush);

            let saved = SaveDC(mem_dc);
            IntersectClipRect(mem_dc, bar_l, bar_t, bar_r, bar_b);
            let null_pen = CreatePen(PS_NULL, 0, 0);
            let fill_brush = CreateSolidBrush(pal.accent);
            let old_pen = SelectObject(mem_dc, null_pen);
            let old_brush = SelectObject(mem_dc, fill_brush);
            match progress {
                ProgressKind::Determinate { done, total } if total > 0 => {
                    let ratio = (done as f64 / total as f64).clamp(0.0, 1.0);
                    let fill_w = (bar_w as f64 * ratio).round() as i32;
                    if fill_w > 0 {
                        let w_clamped = fill_w.max(bar_h).min(bar_w);
                        RoundRect(
                            mem_dc,
                            bar_l,
                            bar_t,
                            bar_l + w_clamped + 1,
                            bar_b + 1,
                            radius,
                            radius,
                        );
                    }
                }
                _ => {
                    let seg_w = (bar_w * 30 / 100).max(s(48));
                    let x = if animations_enabled() {
                        let cycle = (bar_w + seg_w) as u32;
                        let pos = ((st.anim_tick * s(7).max(2) as u32) % cycle.max(1)) as i32;
                        bar_l - seg_w + pos
                    } else {
                        bar_l + (bar_w - seg_w) / 2
                    };
                    RoundRect(mem_dc, x, bar_t, x + seg_w + 1, bar_b + 1, radius, radius);
                }
            }
            SelectObject(mem_dc, old_pen);
            SelectObject(mem_dc, old_brush);
            DeleteObject(null_pen);
            DeleteObject(fill_brush);
            RestoreDC(mem_dc, saved);
        }
    }

    // Subtle footer divider
    unsafe {
        let div_pen = CreatePen(PS_SOLID, 1, pal.divider);
        let old_pen = SelectObject(mem_dc, div_pen);
        MoveToEx(mem_dc, s(24), s(128), std::ptr::null_mut());
        LineTo(mem_dc, s(416), s(128));
        SelectObject(mem_dc, old_pen);
        DeleteObject(div_pen);
    }

    if error_view.is_none() {
        let footer = if cancelling {
            "正在取消并恢复旧版，请稍候…"
        } else if committed {
            match mode {
                UiMode::Uninstall => "正在移除程序文件，此时不可取消",
                UiMode::Update | UiMode::Install => "正在完成版本切换，此时不可取消",
            }
        } else {
            match mode {
                UiMode::Update => "更新完成后自动重启，保留现有配置与比赛资料",
                UiMode::Install => "保留现有配置与比赛资料",
                UiMode::Uninstall => "正在移除程序文件，此时不可取消",
            }
        };
        let footer_right = if mode == UiMode::Uninstall {
            s(416)
        } else {
            s(320)
        };
        draw_text(
            mem_dc,
            st.res.font_small,
            pal.fg_muted,
            footer,
            Rect {
                left: s(24),
                top: s(140),
                right: footer_right,
                bottom: s(172),
            },
            DT_LEFT | DT_VCENTER | DT_WORDBREAK,
        );
    }

    unsafe {
        BitBlt(target_hdc, 0, 0, w, h, mem_dc, 0, 0, SRCCOPY);
        SelectObject(mem_dc, old_bmp);
        DeleteObject(mem_bmp);
        DeleteDC(mem_dc);
    }
}

fn trigger_cancel(hwnd: isize, st: &mut WindowState) {
    if st.in_error_ui {
        unsafe { DestroyWindow(hwnd) };
        return;
    }
    if !st.committed.load(Ordering::Acquire) {
        st.cancelled.store(true, Ordering::Release);
        {
            let mut guard = st.shared.lock().unwrap_or_else(|e| e.into_inner());
            guard.cancelling = true;
            guard.stage = "正在取消…".to_string();
            guard.progress = ProgressKind::Indeterminate;
        }
        st.sync_from_shared(hwnd);
    }
}

extern "system" fn wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
    match msg {
        WM_ERASEBKGND => 1,
        WM_CTLCOLORBTN => {
            if !ptr.is_null() {
                let st = unsafe { &*ptr };
                return st.res.bg_brush;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_PAINT => {
            let mut ps = PaintStruct {
                hdc: 0,
                f_erase: 0,
                rc_paint: Rect::default(),
                f_restore: 0,
                f_inc_update: 0,
                rgb_reserved: [0; 32],
            };
            let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
            if !ptr.is_null() && hdc != 0 {
                let st = unsafe { &*ptr };
                paint_window(hwnd, hdc, st);
            }
            unsafe { EndPaint(hwnd, &ps) };
            0
        }
        WM_PRINTCLIENT => {
            if !ptr.is_null() && wparam != 0 {
                let st = unsafe { &*ptr };
                paint_window(hwnd, wparam as isize, st);
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_TIMER => {
            if wparam == TIMER_ANIM_ID && !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                st.anim_tick = st.anim_tick.wrapping_add(1);
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
            } else if wparam == TIMER_PREVIEW_ID {
                unsafe {
                    KillTimer(hwnd, TIMER_PREVIEW_ID);
                    DestroyWindow(hwnd);
                }
            }
            0
        }
        WM_COMMAND => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                let id = wparam & 0xFFFF;
                match id {
                    IDC_CANCEL => trigger_cancel(hwnd, st),
                    IDC_CLOSE => {
                        if st.in_error_ui {
                            unsafe { DestroyWindow(hwnd) };
                        }
                    }
                    IDC_OPEN_LOGS => {
                        let logs_dir = {
                            let guard = st.shared.lock().unwrap_or_else(|e| e.into_inner());
                            guard.error.as_ref().and_then(|e| e.logs_dir.clone())
                        };
                        if let Some(dir) = logs_dir {
                            let _ = Command::new("explorer.exe").arg(dir).spawn();
                        }
                    }
                    _ => {}
                }
            }
            0
        }
        WM_APP_SYNC => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                st.sync_from_shared(hwnd);
            }
            0
        }
        WM_APP_CLOSE => {
            unsafe {
                KillTimer(hwnd, TIMER_ANIM_ID);
                KillTimer(hwnd, TIMER_PREVIEW_ID);
                DestroyWindow(hwnd);
            }
            0
        }
        WM_DPICHANGED => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                let new_dpi = ((wparam & 0xFFFF) as u32).max(96);
                let suggested = unsafe { &*(lparam as *const Rect) };
                unsafe {
                    SetWindowPos(
                        hwnd,
                        0,
                        suggested.left,
                        suggested.top,
                        suggested.right - suggested.left,
                        suggested.bottom - suggested.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
                st.rebuild_resources(hwnd, new_dpi);
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
            }
            0
        }
        WM_SYSCOLORCHANGE | WM_SETTINGCHANGE => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                let dpi = st.res.dpi;
                st.rebuild_resources(hwnd, dpi);
                st.sync_from_shared(hwnd);
            }
            0
        }
        WM_CLOSE => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                trigger_cancel(hwnd, st);
            }
            0
        }
        WM_DESTROY => {
            unsafe {
                KillTimer(hwnd, TIMER_ANIM_ID);
                KillTimer(hwnd, TIMER_PREVIEW_ID);
                if !ptr.is_null() {
                    let st = &mut *ptr;
                    st.res.destroy();
                }
                PostQuitMessage(0);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn title_for_mode(mode: UiMode) -> &'static str {
    match mode {
        UiMode::Update => UPDATE_WINDOW_TITLE,
        UiMode::Install => "Mizar 安装",
        UiMode::Uninstall => "卸载 Mizar",
    }
}

pub struct ProgressUi {
    hwnd: Arc<AtomicIsize>,
    shared: Arc<Mutex<SharedState>>,
    cancelled: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
    last_reported_pct: AtomicU64,
    thread: Option<JoinHandle<()>>,
}

impl ProgressUi {
    pub fn start(
        no_ui: bool,
        mode: UiMode,
        initial_stage: &str,
        version_label: Option<String>,
    ) -> Self {
        Self::start_internal(no_ui, mode, initial_stage, version_label, None)
    }

    fn start_internal(
        no_ui: bool,
        mode: UiMode,
        initial_stage: &str,
        version_label: Option<String>,
        preview_hold_ms: Option<u64>,
    ) -> Self {
        let hwnd_atomic = Arc::new(AtomicIsize::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(SharedState {
            mode,
            stage: initial_stage.to_owned(),
            version_label,
            progress: ProgressKind::Indeterminate,
            committed: false,
            cancelling: false,
            error: None,
        }));
        if no_ui {
            return Self {
                hwnd: hwnd_atomic,
                shared,
                cancelled,
                committed,
                last_reported_pct: AtomicU64::new(u64::MAX),
                thread: None,
            };
        }

        let (ready_tx, ready_rx) = mpsc::sync_channel::<()>(1);
        let h_clone = hwnd_atomic.clone();
        let s_clone = shared.clone();
        let c_clone = cancelled.clone();
        let m_clone = committed.clone();

        let thread = std::thread::Builder::new()
            .name("mizar-applier-ui".into())
            .spawn(move || {
                let icc = InitCommonControls {
                    size: std::mem::size_of::<InitCommonControls>() as u32,
                    icc: 0x0000_4000, // ICC_STANDARD_CLASSES
                };
                unsafe { InitCommonControlsEx(&icc) };
                let hinst = unsafe { GetModuleHandleW(std::ptr::null()) };
                let class_name = to_wide(UPDATE_WINDOW_CLASS);
                let cursor = unsafe { LoadCursorW(0, 32512 as *const u16) }; // IDC_ARROW
                let wc = WndClassExW {
                    cb_size: std::mem::size_of::<WndClassExW>() as u32,
                    style: 0,
                    lpfn_wnd_proc: wnd_proc,
                    cb_cls_extra: 0,
                    cb_wnd_extra: 0,
                    h_instance: hinst,
                    h_icon: load_app_icon(hinst, 32),
                    h_cursor: cursor,
                    hbr_background: 0,
                    lpsz_menu_name: std::ptr::null(),
                    lpsz_class_name: class_name.as_ptr(),
                    h_icon_sm: load_app_icon(hinst, 16),
                };
                unsafe { RegisterClassExW(&wc) };

                let title = to_wide(title_for_mode(mode));
                let hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        class_name.as_ptr(),
                        title.as_ptr(),
                        WINDOW_STYLE,
                        0,
                        0,
                        LOGICAL_W,
                        LOGICAL_H,
                        0,
                        0,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                if hwnd == 0 {
                    let _ = ready_tx.send(());
                    return;
                }

                let dpi = {
                    let raw = unsafe { GetDpiForWindow(hwnd) };
                    if raw == 0 {
                        96
                    } else {
                        raw
                    }
                };

                let mut adj = Rect {
                    left: 0,
                    top: 0,
                    right: scale(LOGICAL_W, dpi),
                    bottom: scale(LOGICAL_H, dpi),
                };
                unsafe { AdjustWindowRectExForDpi(&mut adj, WINDOW_STYLE, 0, 0, dpi) };
                let win_w = adj.right - adj.left;
                let win_h = adj.bottom - adj.top;

                let mut work = Rect::default();
                let has_work = unsafe {
                    SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut work as *mut Rect).cast(), 0)
                } != 0;
                let (x, y) = if has_work {
                    (
                        work.left + ((work.right - work.left - win_w).max(0) / 2),
                        work.top + ((work.bottom - work.top - win_h).max(0) / 2),
                    )
                } else {
                    (120, 120)
                };

                let btn_cls = to_wide("BUTTON");
                let cancel_w = to_wide("取消");
                let logs_w = to_wide("打开日志目录");
                let close_w = to_wide("关闭");

                let cancel_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        btn_cls.as_ptr(),
                        cancel_w.as_ptr(),
                        WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
                        0,
                        0,
                        84,
                        32,
                        hwnd,
                        IDC_CANCEL as isize,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                let logs_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        btn_cls.as_ptr(),
                        logs_w.as_ptr(),
                        WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
                        0,
                        0,
                        112,
                        32,
                        hwnd,
                        IDC_OPEN_LOGS as isize,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                let close_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        btn_cls.as_ptr(),
                        close_w.as_ptr(),
                        WS_CHILD | WS_TABSTOP | BS_DEFPUSHBUTTON,
                        0,
                        0,
                        84,
                        32,
                        hwnd,
                        IDC_CLOSE as isize,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };

                let res = WindowResources::create(hinst, dpi);
                apply_dark_chrome(hwnd, res.palette.high_contrast);
                unsafe {
                    if res.icon_big != 0 {
                        SendMessageW(hwnd, WM_SETICON, ICON_BIG, res.icon_big);
                    }
                    if res.icon_small != 0 {
                        SendMessageW(hwnd, WM_SETICON, ICON_SMALL, res.icon_small);
                    }
                }

                let mut state = Box::new(WindowState {
                    hinst,
                    res,
                    cancel_hwnd,
                    logs_hwnd,
                    close_hwnd,
                    shared: s_clone,
                    cancelled: c_clone,
                    committed: m_clone,
                    anim_running: false,
                    anim_tick: 0,
                    in_error_ui: false,
                });
                state.layout_controls();
                state.sync_from_shared(hwnd);

                let state_ptr = Box::into_raw(state);
                unsafe {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);
                    SetWindowPos(hwnd, 0, x, y, win_w, win_h, SWP_NOZORDER);
                    ShowWindow(hwnd, SW_SHOW);
                    UpdateWindow(hwnd);
                }

                if let Some(ms) = preview_hold_ms {
                    unsafe {
                        SetTimer(
                            hwnd,
                            TIMER_PREVIEW_ID,
                            ms.min(u32::MAX as u64) as u32,
                            std::ptr::null(),
                        );
                    }
                }

                h_clone.store(hwnd, Ordering::Release);
                let _ = ready_tx.send(());

                let mut msg = Msg {
                    hwnd: 0,
                    message: 0,
                    wparam: 0,
                    lparam: 0,
                    time: 0,
                    pt_x: 0,
                    pt_y: 0,
                };
                while unsafe { GetMessageW(&mut msg, 0, 0, 0) } > 0 {
                    unsafe {
                        if IsDialogMessageW(hwnd, &msg) == 0 {
                            TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                }
                h_clone.store(0, Ordering::Release);
                unsafe {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    drop(Box::from_raw(state_ptr));
                }
            })
            .ok();

        if thread.is_some() {
            let _ = ready_rx.recv();
        }

        Self {
            hwnd: hwnd_atomic,
            shared,
            cancelled,
            committed,
            last_reported_pct: AtomicU64::new(u64::MAX),
            thread,
        }
    }

    fn notify_sync(&self) {
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_SYNC, 0, 0) };
        }
    }

    pub fn set_version_label(&self, label: String) {
        {
            let mut guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            guard.version_label = Some(label);
        }
        self.notify_sync();
    }

    pub fn set_stage(&self, text: &str, progress: ProgressKind) {
        self.last_reported_pct.store(u64::MAX, Ordering::Release);
        {
            let mut guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            guard.stage = text.to_owned();
            guard.progress = progress;
        }
        self.notify_sync();
    }

    pub fn set_progress(&self, done: u64, total: u64) {
        if total == 0 {
            return;
        }
        let pct = (done.saturating_mul(100) / total).min(100);
        let prev = self.last_reported_pct.swap(pct, Ordering::AcqRel);
        if prev == pct {
            return;
        }
        {
            let mut guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            guard.progress = ProgressKind::Determinate { done, total };
        }
        self.notify_sync();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn enter_commit(&self) {
        self.committed.store(true, Ordering::Release);
        {
            let mut guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            guard.committed = true;
        }
        self.notify_sync();
    }

    pub fn show_error_and_wait(
        mut self,
        heading: &str,
        impact: &str,
        detail: &str,
        logs_dir: Option<&Path>,
    ) {
        if self.thread.is_none() {
            return;
        }
        {
            let mut guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            guard.error = Some(ErrorView {
                heading: heading.to_owned(),
                impact: impact.to_owned(),
                detail: detail.to_owned(),
                logs_dir: logs_dir.map(Path::to_path_buf),
            });
        }
        self.notify_sync();
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }

    pub fn close(mut self) {
        let hwnd = self.hwnd.swap(0, Ordering::AcqRel);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_CLOSE, 0, 0) };
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }

    pub fn run_preview(state: &str, hold_ms: Option<u64>) {
        match state {
            "verifying" => {
                let mut ui = Self::start_internal(
                    false,
                    UiMode::Update,
                    "正在校验更新文件…",
                    Some("v1.12.0 → v1.13.0".to_string()),
                    hold_ms,
                );
                ui.set_progress(42, 100);
                if let Some(handle) = ui.thread.take() {
                    let _ = handle.join();
                }
            }
            "commit" => {
                let mut ui = Self::start_internal(
                    false,
                    UiMode::Update,
                    "正在应用更新…",
                    Some("v1.12.0 → v1.13.0".to_string()),
                    hold_ms,
                );
                ui.enter_commit();
                if let Some(handle) = ui.thread.take() {
                    let _ = handle.join();
                }
            }
            "error" => {
                let ui = Self::start_internal(
                    false,
                    UiMode::Update,
                    "正在校验更新文件…",
                    Some("v1.12.0 → v1.13.0".to_string()),
                    hold_ms,
                );
                let logs = std::env::temp_dir();
                ui.show_error_and_wait(
                    "更新未完成",
                    "原程序未被替换，配置与比赛资料未受影响。",
                    "原因：安装包校验未通过，请重新检查更新或从官方发布页下载。",
                    Some(&logs),
                );
            }
            "uninstall" => {
                let mut ui = Self::start_internal(
                    false,
                    UiMode::Uninstall,
                    "正在卸载 Mizar…",
                    None,
                    hold_ms,
                );
                ui.enter_commit();
                if let Some(handle) = ui.thread.take() {
                    let _ = handle.join();
                }
            }
            _ => {
                let mut ui = Self::start_internal(
                    false,
                    UiMode::Update,
                    "正在启动新版 Mizar…",
                    Some("v1.12.0 → v1.13.0".to_string()),
                    hold_ms,
                );
                ui.enter_commit();
                if let Some(handle) = ui.thread.take() {
                    let _ = handle.join();
                }
            }
        }
    }
}

impl Drop for ProgressUi {
    fn drop(&mut self) {
        let hwnd = self.hwnd.swap(0, Ordering::AcqRel);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_CLOSE, 0, 0) };
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}
