use mizar_common::{to_wide, UPDATE_WINDOW_CLASS, UPDATE_WINDOW_TITLE};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWINDOWATTRIBUTE,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW, CreatePen,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GetSysColor,
    IntersectClipRect, InvalidateRect, LineTo, MoveToEx, RestoreDC, RoundRect, SaveDC,
    SelectObject, SetBkMode, SetTextColor, UpdateWindow, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
    COLOR_BTNSHADOW, COLOR_GRAYTEXT, COLOR_HIGHLIGHT, COLOR_WINDOW, COLOR_WINDOWTEXT,
    DEFAULT_CHARSET, DEFAULT_PITCH, DT_END_ELLIPSIS, DT_LEFT, DT_NOPREFIX, DT_RIGHT, DT_SINGLELINE,
    DT_VCENTER, DT_WORDBREAK, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HBRUSH, HDC, HFONT, HGDIOBJ,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_NULL, PS_SOLID, SRCCOPY, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, SetWindowTheme, ICC_STANDARD_CLASSES, INITCOMMONCONTROLSEX,
};
use windows::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow};
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW, DrawIconEx,
    EnableMenuItem, GetClientRect, GetMessageW, GetSystemMenu, GetWindowLongPtrW, IsDialogMessageW,
    KillTimer, LoadCursorW, LoadImageW, MoveWindow, PostMessageW, PostQuitMessage,
    RegisterClassExW, SendMessageW, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    SystemParametersInfoW, TranslateMessage, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, DI_NORMAL,
    GWLP_USERDATA, HICON, ICON_BIG, ICON_SMALL, IDCANCEL, IDC_ARROW, IDOK, IMAGE_ICON,
    LR_DEFAULTCOLOR, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, MSG, SC_CLOSE,
    SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST, SPI_GETWORKAREA, SWP_NOACTIVATE, SWP_NOZORDER,
    SW_HIDE, SW_SHOW, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
    WM_CLOSE, WM_COMMAND, WM_CTLCOLORBTN, WM_DESTROY, WM_DPICHANGED, WM_ERASEBKGND, WM_PAINT,
    WM_PRINTCLIENT, WM_SETFONT, WM_SETICON, WM_SETTINGCHANGE, WM_SYSCOLORCHANGE, WM_TIMER,
    WNDCLASSEXW, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP,
};

const WM_APP_SYNC: u32 = WM_APP + 1;
const WM_APP_CLOSE: u32 = WM_APP + 2;

const MAIN_WINDOW_STYLE: WINDOW_STYLE =
    WINDOW_STYLE(WS_OVERLAPPED.0 | WS_CAPTION.0 | WS_SYSMENU.0 | WS_CLIPCHILDREN.0);

const IDC_OPEN_LOGS: usize = 1002;
const TIMER_ANIM_ID: usize = 1;
#[cfg(feature = "ui-preview")]
const TIMER_PREVIEW_ID: usize = 2;

const LOGICAL_W: i32 = 440;
const LOGICAL_H: i32 = 184;

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
    cancelling: bool,
    error: Option<ErrorView>,
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

fn scale(v: i32, dpi: u32) -> i32 {
    (v * dpi as i32 + 48) / 96
}

fn is_high_contrast() -> bool {
    let mut hc = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            hc.cbSize,
            Some((&mut hc as *mut HIGHCONTRASTW).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    ok.is_ok() && (hc.dwFlags.0 & HCF_HIGHCONTRASTON.0) != 0
}

fn animations_enabled() -> bool {
    let mut enabled: i32 = 1;
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut enabled as *mut i32).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    ok.is_err() || enabled != 0
}

fn make_font(px: i32, weight: i32) -> HFONT {
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
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
            w!("Microsoft YaHei UI"),
        )
    }
}

fn load_app_icon(hinst: HINSTANCE, size_px: i32) -> HICON {
    unsafe {
        LoadImageW(
            Some(hinst),
            PCWSTR(1 as *const u16),
            IMAGE_ICON,
            size_px,
            size_px,
            LR_DEFAULTCOLOR,
        )
        .map(|h| HICON(h.0))
        .unwrap_or_default()
    }
}

fn apply_dark_chrome(hwnd: HWND, high_contrast: bool) {
    let val: i32 = i32::from(!high_contrast);
    unsafe {
        let hr = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&val as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
        if hr.is_err() {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(19),
                (&val as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
}

fn apply_button_theme(btn: HWND, high_contrast: bool) {
    if btn.is_invalid() {
        return;
    }
    unsafe {
        if high_contrast {
            let _ = SetWindowTheme(btn, PCWSTR::null(), PCWSTR::null());
        } else {
            let _ = SetWindowTheme(btn, w!("DarkMode_Explorer"), PCWSTR::null());
        }
    }
}

fn set_close_enabled(hwnd: HWND, enabled: bool) {
    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if !menu.is_invalid() {
            let flags = MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED };
            let _ = EnableMenuItem(menu, SC_CLOSE, flags);
        }
    }
}

struct WindowResources {
    dpi: u32,
    palette: Palette,
    bg_brush: HBRUSH,
    font_heading: HFONT,
    font_body: HFONT,
    font_small: HFONT,
    brand_icon: HICON,
    icon_big: HICON,
    icon_small: HICON,
}

impl WindowResources {
    fn create(hinst: HINSTANCE, dpi: u32) -> Self {
        let palette = Palette::current();
        let bg_brush = unsafe { CreateSolidBrush(COLORREF(palette.bg)) };
        let font_heading = make_font(scale(16, dpi), FW_SEMIBOLD.0 as i32);
        let font_body = make_font(scale(13, dpi), FW_NORMAL.0 as i32);
        let font_small = make_font(scale(12, dpi), FW_NORMAL.0 as i32);
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
            let objs: [HGDIOBJ; 4] = [
                self.bg_brush.into(),
                self.font_heading.into(),
                self.font_body.into(),
                self.font_small.into(),
            ];
            for obj in objs {
                if !obj.is_invalid() {
                    let _ = DeleteObject(obj);
                }
            }
            for icon in [
                &mut self.brand_icon,
                &mut self.icon_big,
                &mut self.icon_small,
            ] {
                if !icon.is_invalid() {
                    let _ = DestroyIcon(*icon);
                    *icon = HICON::default();
                }
            }
        }
        self.bg_brush = HBRUSH::default();
        self.font_heading = HFONT::default();
        self.font_body = HFONT::default();
        self.font_small = HFONT::default();
    }
}

struct WindowState {
    hinst: HINSTANCE,
    res: WindowResources,
    cancel_hwnd: HWND,
    logs_hwnd: HWND,
    close_hwnd: HWND,
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
            let _ = MoveWindow(
                self.cancel_hwnd,
                scale(332, d),
                btn_y,
                scale(84, d),
                btn_h,
                true,
            );
            let _ = MoveWindow(
                self.logs_hwnd,
                scale(208, d),
                btn_y,
                scale(112, d),
                btn_h,
                true,
            );
            let _ = MoveWindow(
                self.close_hwnd,
                scale(332, d),
                btn_y,
                scale(84, d),
                btn_h,
                true,
            );
            for btn in [self.cancel_hwnd, self.logs_hwnd, self.close_hwnd] {
                SendMessageW(
                    btn,
                    WM_SETFONT,
                    Some(WPARAM(self.res.font_body.0 as usize)),
                    Some(LPARAM(1)),
                );
                apply_button_theme(btn, self.res.palette.high_contrast);
            }
        }
    }

    fn rebuild_resources(&mut self, hwnd: HWND, new_dpi: u32) {
        self.res.destroy();
        self.res = WindowResources::create(self.hinst, new_dpi);
        apply_dark_chrome(hwnd, self.res.palette.high_contrast);
        unsafe {
            if !self.res.icon_big.is_invalid() {
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_BIG as usize)),
                    Some(LPARAM(self.res.icon_big.0 as isize)),
                );
            }
            if !self.res.icon_small.is_invalid() {
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_SMALL as usize)),
                    Some(LPARAM(self.res.icon_small.0 as isize)),
                );
            }
        }
        self.layout_controls();
    }

    fn sync_from_shared(&mut self, hwnd: HWND) {
        let committed = self.committed.load(Ordering::Acquire);
        let (mode, progress, cancelling, error_view) = {
            let guard = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            (
                guard.mode,
                guard.progress,
                guard.cancelling,
                guard.error.clone(),
            )
        };

        let need_anim = error_view.is_none()
            && matches!(progress, ProgressKind::Indeterminate)
            && animations_enabled();
        if need_anim && !self.anim_running {
            unsafe { SetTimer(Some(hwnd), TIMER_ANIM_ID, 33, None) };
            self.anim_running = true;
        } else if !need_anim && self.anim_running {
            let _ = unsafe { KillTimer(Some(hwnd), TIMER_ANIM_ID) };
            self.anim_running = false;
        }

        if let Some(err) = error_view {
            if !self.in_error_ui {
                self.in_error_ui = true;
                set_close_enabled(hwnd, true);
                unsafe {
                    let _ = ShowWindow(self.cancel_hwnd, SW_HIDE);
                    let _ = ShowWindow(
                        self.logs_hwnd,
                        if err.logs_dir.is_some() {
                            SW_SHOW
                        } else {
                            SW_HIDE
                        },
                    );
                    let _ = ShowWindow(self.close_hwnd, SW_SHOW);
                    let _ = SetFocus(Some(self.close_hwnd));
                }
            }
        } else {
            let show_cancel = mode != UiMode::Uninstall;
            let can_cancel = show_cancel && !committed && !cancelling;
            set_close_enabled(hwnd, can_cancel);
            unsafe {
                let _ = ShowWindow(self.logs_hwnd, SW_HIDE);
                let _ = ShowWindow(self.close_hwnd, SW_HIDE);
                let _ = ShowWindow(
                    self.cancel_hwnd,
                    if show_cancel { SW_SHOW } else { SW_HIDE },
                );
                let _ = EnableWindow(self.cancel_hwnd, can_cancel);
            }
        }

        let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
    }
}

fn draw_text(
    hdc: HDC,
    font: HFONT,
    color: u32,
    text: &str,
    mut rect: RECT,
    flags: windows::Win32::Graphics::Gdi::DRAW_TEXT_FORMAT,
) {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        let prev = SelectObject(hdc, font.into());
        SetTextColor(hdc, COLORREF(color));
        DrawTextW(hdc, &mut wide, &mut rect, flags | DT_NOPREFIX);
        SelectObject(hdc, prev);
    }
}

fn paint_window(hwnd: HWND, target_hdc: HDC, st: &WindowState) {
    let mut rc = RECT::default();
    let _ = unsafe { GetClientRect(hwnd, &mut rc) };
    let w = (rc.right - rc.left).max(1);
    let h = (rc.bottom - rc.top).max(1);

    let mem_dc = unsafe { CreateCompatibleDC(Some(target_hdc)) };
    let mem_bmp = unsafe { CreateCompatibleBitmap(target_hdc, w, h) };
    let old_bmp = unsafe { SelectObject(mem_dc, mem_bmp.into()) };

    let d = st.res.dpi;
    let s = |v: i32| scale(v, d);
    let pal = &st.res.palette;

    unsafe {
        FillRect(mem_dc, &rc, st.res.bg_brush);
        SetBkMode(mem_dc, TRANSPARENT);
    }

    let committed = st.committed.load(Ordering::Acquire);
    let (mode, stage, version_label, progress, cancelling, error_view) = {
        let guard = st.shared.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.mode,
            guard.stage.clone(),
            guard.version_label.clone(),
            guard.progress,
            guard.cancelling,
            guard.error.clone(),
        )
    };

    if error_view.is_some() {
        let danger_brush = unsafe { CreateSolidBrush(COLORREF(pal.danger)) };
        let strip = RECT {
            left: 0,
            top: 0,
            right: w,
            bottom: s(3).max(2),
        };
        unsafe {
            FillRect(mem_dc, &strip, danger_brush);
            let _ = DeleteObject(danger_brush.into());
        }
    }

    if !st.res.brand_icon.is_invalid() {
        let _ = unsafe {
            DrawIconEx(
                mem_dc,
                s(24),
                s(22),
                st.res.brand_icon,
                s(32),
                s(32),
                0,
                None,
                DI_NORMAL,
            )
        };
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
            RECT {
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
            RECT {
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
            RECT {
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
            RECT {
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
            RECT {
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
                RECT {
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
            let track_pen = CreatePen(PS_SOLID, 1, COLORREF(pal.border));
            let track_brush = CreateSolidBrush(COLORREF(pal.track));
            let old_pen = SelectObject(mem_dc, track_pen.into());
            let old_brush = SelectObject(mem_dc, track_brush.into());
            let _ = RoundRect(mem_dc, bar_l, bar_t, bar_r, bar_b, radius, radius);
            SelectObject(mem_dc, old_pen);
            SelectObject(mem_dc, old_brush);
            let _ = DeleteObject(track_pen.into());
            let _ = DeleteObject(track_brush.into());

            let saved = SaveDC(mem_dc);
            IntersectClipRect(mem_dc, bar_l, bar_t, bar_r, bar_b);
            let null_pen = CreatePen(PS_NULL, 0, COLORREF(0));
            let fill_brush = CreateSolidBrush(COLORREF(pal.accent));
            let old_pen = SelectObject(mem_dc, null_pen.into());
            let old_brush = SelectObject(mem_dc, fill_brush.into());
            match progress {
                ProgressKind::Determinate { done, total } if total > 0 => {
                    let ratio = (done as f64 / total as f64).clamp(0.0, 1.0);
                    let fill_w = (bar_w as f64 * ratio).round() as i32;
                    if fill_w > 0 {
                        let w_clamped = fill_w.max(bar_h).min(bar_w);
                        let _ = RoundRect(
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
                    let _ = RoundRect(mem_dc, x, bar_t, x + seg_w + 1, bar_b + 1, radius, radius);
                }
            }
            SelectObject(mem_dc, old_pen);
            SelectObject(mem_dc, old_brush);
            let _ = DeleteObject(null_pen.into());
            let _ = DeleteObject(fill_brush.into());
            let _ = RestoreDC(mem_dc, saved);
        }
    }

    // Subtle footer divider
    unsafe {
        let div_pen = CreatePen(PS_SOLID, 1, COLORREF(pal.divider));
        let old_pen = SelectObject(mem_dc, div_pen.into());
        let _ = MoveToEx(mem_dc, s(24), s(128), None);
        let _ = LineTo(mem_dc, s(416), s(128));
        SelectObject(mem_dc, old_pen);
        let _ = DeleteObject(div_pen.into());
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
            RECT {
                left: s(24),
                top: s(140),
                right: footer_right,
                bottom: s(172),
            },
            DT_LEFT | DT_VCENTER | DT_WORDBREAK,
        );
    }

    unsafe {
        let _ = BitBlt(target_hdc, 0, 0, w, h, Some(mem_dc), 0, 0, SRCCOPY);
        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(mem_bmp.into());
        let _ = DeleteDC(mem_dc);
    }
}

fn trigger_cancel(hwnd: HWND, st: &mut WindowState) {
    if st.in_error_ui {
        let _ = unsafe { DestroyWindow(hwnd) };
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

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
    match msg {
        WM_ERASEBKGND => LRESULT(1),
        WM_CTLCOLORBTN => {
            if !ptr.is_null() {
                let st = unsafe { &*ptr };
                return LRESULT(st.res.bg_brush.0 as isize);
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
            if !ptr.is_null() && !hdc.is_invalid() {
                let st = unsafe { &*ptr };
                paint_window(hwnd, hdc, st);
            }
            let _ = unsafe { EndPaint(hwnd, &ps) };
            LRESULT(0)
        }
        WM_PRINTCLIENT => {
            if !ptr.is_null() && wparam.0 != 0 {
                let st = unsafe { &*ptr };
                paint_window(hwnd, HDC(wparam.0 as *mut c_void), st);
                return LRESULT(0);
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_TIMER => {
            if wparam.0 == TIMER_ANIM_ID && !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                st.anim_tick = st.anim_tick.wrapping_add(1);
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            } else {
                #[cfg(feature = "ui-preview")]
                if wparam.0 == TIMER_PREVIEW_ID {
                    let _ = unsafe { KillTimer(Some(hwnd), TIMER_PREVIEW_ID) };
                    let _ = unsafe { DestroyWindow(hwnd) };
                }
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                let id = (wparam.0 & 0xFFFF) as i32;
                if id == IDCANCEL.0 {
                    trigger_cancel(hwnd, st);
                } else if id == IDOK.0 {
                    if st.in_error_ui {
                        let _ = unsafe { DestroyWindow(hwnd) };
                    }
                } else if id as usize == IDC_OPEN_LOGS {
                    let logs_dir = {
                        let guard = st.shared.lock().unwrap_or_else(|e| e.into_inner());
                        guard.error.as_ref().and_then(|e| e.logs_dir.clone())
                    };
                    if let Some(dir) = logs_dir {
                        let _ = Command::new("explorer.exe").arg(dir).spawn();
                    }
                }
            }
            LRESULT(0)
        }
        WM_APP_SYNC => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                st.sync_from_shared(hwnd);
            }
            LRESULT(0)
        }
        WM_APP_CLOSE => {
            unsafe {
                let _ = KillTimer(Some(hwnd), TIMER_ANIM_ID);
                #[cfg(feature = "ui-preview")]
                let _ = KillTimer(Some(hwnd), TIMER_PREVIEW_ID);
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DPICHANGED => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                let new_dpi = ((wparam.0 & 0xFFFF) as u32).max(96);
                let suggested = unsafe { &*(lparam.0 as *const RECT) };
                let _ = unsafe {
                    SetWindowPos(
                        hwnd,
                        None,
                        suggested.left,
                        suggested.top,
                        suggested.right - suggested.left,
                        suggested.bottom - suggested.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                };
                st.rebuild_resources(hwnd, new_dpi);
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_SYSCOLORCHANGE | WM_SETTINGCHANGE => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                let dpi = st.res.dpi;
                st.rebuild_resources(hwnd, dpi);
                st.sync_from_shared(hwnd);
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            if !ptr.is_null() {
                let st = unsafe { &mut *ptr };
                trigger_cancel(hwnd, st);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe {
                let _ = KillTimer(Some(hwnd), TIMER_ANIM_ID);
                #[cfg(feature = "ui-preview")]
                let _ = KillTimer(Some(hwnd), TIMER_PREVIEW_ID);
                if !ptr.is_null() {
                    let st = &mut *ptr;
                    st.res.destroy();
                }
                PostQuitMessage(0);
            }
            LRESULT(0)
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
        #[allow(unused_variables)] preview_hold_ms: Option<u64>,
    ) -> Self {
        let hwnd_atomic = Arc::new(AtomicIsize::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(SharedState {
            mode,
            stage: initial_stage.to_owned(),
            version_label,
            progress: ProgressKind::Indeterminate,
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
                let icc = INITCOMMONCONTROLSEX {
                    dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                    dwICC: ICC_STANDARD_CLASSES,
                };
                let _ = unsafe { InitCommonControlsEx(&icc) };
                let hinst: HINSTANCE = unsafe { GetModuleHandleW(None) }
                    .map(Into::into)
                    .unwrap_or_default();
                let class_name = to_wide(UPDATE_WINDOW_CLASS);
                let cursor = unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default();
                let wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: Default::default(),
                    lpfnWndProc: Some(wnd_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: hinst,
                    hIcon: load_app_icon(hinst, 32),
                    hCursor: cursor,
                    hbrBackground: HBRUSH::default(),
                    lpszMenuName: PCWSTR::null(),
                    lpszClassName: PCWSTR(class_name.as_ptr()),
                    hIconSm: load_app_icon(hinst, 16),
                };
                unsafe { RegisterClassExW(&wc) };

                let title = to_wide(title_for_mode(mode));
                let Ok(hwnd) = (unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        PCWSTR(class_name.as_ptr()),
                        PCWSTR(title.as_ptr()),
                        MAIN_WINDOW_STYLE,
                        0,
                        0,
                        LOGICAL_W,
                        LOGICAL_H,
                        None,
                        None,
                        Some(hinst),
                        None,
                    )
                }) else {
                    let _ = ready_tx.send(());
                    return;
                };

                let dpi = {
                    let raw = unsafe { GetDpiForWindow(hwnd) };
                    if raw == 0 {
                        96
                    } else {
                        raw
                    }
                };

                let mut adj = RECT {
                    left: 0,
                    top: 0,
                    right: scale(LOGICAL_W, dpi),
                    bottom: scale(LOGICAL_H, dpi),
                };
                let _ = unsafe {
                    AdjustWindowRectExForDpi(
                        &mut adj,
                        MAIN_WINDOW_STYLE,
                        false,
                        WINDOW_EX_STYLE(0),
                        dpi,
                    )
                };
                let win_w = adj.right - adj.left;
                let win_h = adj.bottom - adj.top;

                let mut work = RECT::default();
                let has_work = unsafe {
                    SystemParametersInfoW(
                        SPI_GETWORKAREA,
                        0,
                        Some((&mut work as *mut RECT).cast()),
                        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                    )
                }
                .is_ok();
                let (x, y) = if has_work {
                    (
                        work.left + ((work.right - work.left - win_w).max(0) / 2),
                        work.top + ((work.bottom - work.top - win_h).max(0) / 2),
                    )
                } else {
                    (120, 120)
                };

                let btn_style = WINDOW_STYLE(WS_CHILD.0 | WS_TABSTOP.0 | BS_PUSHBUTTON as u32);
                let def_btn_style =
                    WINDOW_STYLE(WS_CHILD.0 | WS_TABSTOP.0 | BS_DEFPUSHBUTTON as u32);

                let cancel_hwnd = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("取消"),
                        btn_style,
                        0,
                        0,
                        84,
                        32,
                        Some(hwnd),
                        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
                            IDCANCEL.0 as *mut c_void,
                        )),
                        Some(hinst),
                        None,
                    )
                }
                .unwrap_or_default();
                let logs_hwnd = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("打开日志目录"),
                        btn_style,
                        0,
                        0,
                        112,
                        32,
                        Some(hwnd),
                        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
                            IDC_OPEN_LOGS as *mut c_void,
                        )),
                        Some(hinst),
                        None,
                    )
                }
                .unwrap_or_default();
                let close_hwnd = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("关闭"),
                        def_btn_style,
                        0,
                        0,
                        84,
                        32,
                        Some(hwnd),
                        Some(windows::Win32::UI::WindowsAndMessaging::HMENU(
                            IDOK.0 as *mut c_void,
                        )),
                        Some(hinst),
                        None,
                    )
                }
                .unwrap_or_default();

                let res = WindowResources::create(hinst, dpi);
                apply_dark_chrome(hwnd, res.palette.high_contrast);
                unsafe {
                    if !res.icon_big.is_invalid() {
                        SendMessageW(
                            hwnd,
                            WM_SETICON,
                            Some(WPARAM(ICON_BIG as usize)),
                            Some(LPARAM(res.icon_big.0 as isize)),
                        );
                    }
                    if !res.icon_small.is_invalid() {
                        SendMessageW(
                            hwnd,
                            WM_SETICON,
                            Some(WPARAM(ICON_SMALL as usize)),
                            Some(LPARAM(res.icon_small.0 as isize)),
                        );
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
                    let _ = SetWindowPos(hwnd, None, x, y, win_w, win_h, SWP_NOZORDER);
                    let _ = ShowWindow(hwnd, SW_SHOW);
                    let _ = UpdateWindow(hwnd);
                }

                #[cfg(feature = "ui-preview")]
                if let Some(ms) = preview_hold_ms {
                    unsafe {
                        SetTimer(
                            Some(hwnd),
                            TIMER_PREVIEW_ID,
                            ms.min(u32::MAX as u64) as u32,
                            None,
                        );
                    }
                }

                h_clone.store(hwnd.0 as isize, Ordering::Release);
                let _ = ready_tx.send(());

                let mut msg = MSG::default();
                while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
                    unsafe {
                        if !IsDialogMessageW(hwnd, &msg).as_bool() {
                            let _ = TranslateMessage(&msg);
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
        let raw = self.hwnd.load(Ordering::Acquire);
        if raw != 0 {
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(raw as *mut c_void)),
                    WM_APP_SYNC,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
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
        let raw = self.hwnd.swap(0, Ordering::AcqRel);
        if raw != 0 {
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(raw as *mut c_void)),
                    WM_APP_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }

    #[cfg(feature = "ui-preview")]
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
        let raw = self.hwnd.swap(0, Ordering::AcqRel);
        if raw != 0 {
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(raw as *mut c_void)),
                    WM_APP_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                )
            };
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}
