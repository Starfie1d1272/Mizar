use mizar_common::{to_wide, UPDATE_WINDOW_TITLE};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

const WM_DESTROY: u32 = 0x0002;
const WM_CLOSE: u32 = 0x0010;
const WM_COMMAND: u32 = 0x0111;
const WM_TIMER: u32 = 0x0113;
const WM_APP_STAGE: u32 = 0x8001;
const WM_APP_COMMIT: u32 = 0x8002;
const WM_APP_CLOSE: u32 = 0x8003;

const WS_OVERLAPPED: u32 = 0x0000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_SYSMENU: u32 = 0x0008_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WS_CHILD: u32 = 0x4000_0000;
const PBS_MARQUEE: u32 = 0x08;
const PBM_SETMARQUEE: u32 = 0x040A;
const IDC_CANCEL: usize = 1001;
const TIMER_ID: usize = 1;

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
    fn TranslateMessage(msg: *const Msg) -> i32;
    fn DispatchMessageW(msg: *const Msg) -> isize;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn PostQuitMessage(exit_code: i32);
    fn DestroyWindow(hwnd: isize) -> i32;
    fn SetWindowTextW(hwnd: isize, text: *const u16) -> i32;
    fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn EnableWindow(hwnd: isize, enable: i32) -> i32;
    fn SetTimer(hwnd: isize, id: usize, elapse: u32, func: *const c_void) -> usize;
    fn KillTimer(hwnd: isize, id: usize) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, new_long: isize) -> isize;
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[link(name = "comctl32")]
extern "system" {
    fn InitCommonControlsEx(picce: *const InitCommonControls) -> i32;
}

#[repr(C)]
struct InitCommonControls {
    size: u32,
    icc: u32,
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

struct WindowState {
    label_hwnd: isize,
    timer_hwnd: isize,
    cancel_hwnd: isize,
    started: Instant,
    cancelled: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
}

extern "system" fn wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    const GWLP_USERDATA: i32 = -21;
    match msg {
        WM_COMMAND => {
            if (wparam & 0xFFFF) == IDC_CANCEL {
                let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
                if !ptr.is_null() {
                    let st = unsafe { &*ptr };
                    if !st.committed.load(Ordering::Acquire) {
                        st.cancelled.store(true, Ordering::Release);
                        unsafe { EnableWindow(st.cancel_hwnd, 0) };
                        let txt = to_wide("正在取消，请稍候...");
                        unsafe { SetWindowTextW(st.label_hwnd, txt.as_ptr()) };
                    }
                }
            }
            0
        }
        WM_TIMER => {
            let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
            if !ptr.is_null() {
                let st = unsafe { &*ptr };
                let secs = st.started.elapsed().as_secs();
                let txt = to_wide(&format!("已耗时：{secs} 秒"));
                unsafe { SetWindowTextW(st.timer_hwnd, txt.as_ptr()) };
            }
            0
        }
        WM_APP_STAGE => {
            let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
            let text_box = unsafe { Box::from_raw(lparam as *mut Vec<u16>) };
            if !ptr.is_null() {
                let st = unsafe { &*ptr };
                unsafe { SetWindowTextW(st.label_hwnd, text_box.as_ptr()) };
            }
            0
        }
        WM_APP_COMMIT => {
            let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
            if !ptr.is_null() {
                let st = unsafe { &*ptr };
                unsafe { EnableWindow(st.cancel_hwnd, 0) };
            }
            0
        }
        WM_APP_CLOSE => {
            unsafe {
                KillTimer(hwnd, TIMER_ID);
                DestroyWindow(hwnd);
            }
            0
        }
        WM_CLOSE => {
            let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut WindowState;
            if !ptr.is_null() {
                let st = unsafe { &*ptr };
                if !st.committed.load(Ordering::Acquire) {
                    st.cancelled.store(true, Ordering::Release);
                    unsafe { EnableWindow(st.cancel_hwnd, 0) };
                    let txt = to_wide("正在取消，请稍候...");
                    unsafe { SetWindowTextW(st.label_hwnd, txt.as_ptr()) };
                }
            }
            0
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

pub struct ProgressUi {
    hwnd: Arc<AtomicIsize>,
    cancelled: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ProgressUi {
    pub fn start(no_ui: bool, initial_stage: &str) -> Self {
        let hwnd_atomic = Arc::new(AtomicIsize::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        if no_ui {
            return Self {
                hwnd: hwnd_atomic,
                cancelled,
                committed,
                thread: None,
            };
        }
        let h_clone = hwnd_atomic.clone();
        let c_clone = cancelled.clone();
        let m_clone = committed.clone();
        let stage_str = initial_stage.to_owned();
        let thread = std::thread::Builder::new()
            .name("mizar-applier-ui".into())
            .spawn(move || {
                let icc = InitCommonControls {
                    size: std::mem::size_of::<InitCommonControls>() as u32,
                    icc: 0x0000_0020, // ICC_PROGRESS_CLASS
                };
                unsafe { InitCommonControlsEx(&icc) };
                let hinst = unsafe { GetModuleHandleW(std::ptr::null()) };
                let class_name = to_wide("MizarApplierProgressWindow");
                let wc = WndClassExW {
                    cb_size: std::mem::size_of::<WndClassExW>() as u32,
                    style: 0,
                    lpfn_wnd_proc: wnd_proc,
                    cb_cls_extra: 0,
                    cb_wnd_extra: 0,
                    h_instance: hinst,
                    h_icon: 0,
                    h_cursor: 0,
                    hbr_background: 16, // COLOR_BTNFACE + 1
                    lpsz_menu_name: std::ptr::null(),
                    lpsz_class_name: class_name.as_ptr(),
                    h_icon_sm: 0,
                };
                unsafe { RegisterClassExW(&wc) };
                let w = 420;
                let h = 155;
                let sw = unsafe { GetSystemMetrics(0) };
                let sh = unsafe { GetSystemMetrics(1) };
                let x = (sw - w).max(0) / 2;
                let y = (sh - h).max(0) / 2;
                let title = to_wide(UPDATE_WINDOW_TITLE);
                let hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        class_name.as_ptr(),
                        title.as_ptr(),
                        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
                        x,
                        y,
                        w,
                        h,
                        0,
                        0,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                if hwnd == 0 {
                    return;
                }
                let static_cls = to_wide("STATIC");
                let prog_cls = to_wide("msctls_progress32");
                let btn_cls = to_wide("BUTTON");
                let label_w = to_wide(&stage_str);
                let timer_w = to_wide("已耗时：0 秒");
                let cancel_w = to_wide("取消");
                let label_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        static_cls.as_ptr(),
                        label_w.as_ptr(),
                        WS_CHILD | WS_VISIBLE,
                        20,
                        18,
                        370,
                        22,
                        hwnd,
                        0,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                let prog_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        prog_cls.as_ptr(),
                        std::ptr::null(),
                        WS_CHILD | WS_VISIBLE | PBS_MARQUEE,
                        20,
                        48,
                        370,
                        20,
                        hwnd,
                        0,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                unsafe { SendMessageW(prog_hwnd, PBM_SETMARQUEE, 1, 30) };
                let timer_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        static_cls.as_ptr(),
                        timer_w.as_ptr(),
                        WS_CHILD | WS_VISIBLE,
                        20,
                        82,
                        180,
                        20,
                        hwnd,
                        0,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                let cancel_hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        btn_cls.as_ptr(),
                        cancel_w.as_ptr(),
                        WS_CHILD | WS_VISIBLE,
                        300,
                        78,
                        90,
                        26,
                        hwnd,
                        IDC_CANCEL as isize,
                        hinst,
                        std::ptr::null_mut(),
                    )
                };
                let state = Box::new(WindowState {
                    label_hwnd,
                    timer_hwnd,
                    cancel_hwnd,
                    started: Instant::now(),
                    cancelled: c_clone,
                    committed: m_clone,
                });
                let state_ptr = Box::into_raw(state);
                unsafe {
                    SetWindowLongPtrW(hwnd, -21, state_ptr as isize);
                    SetTimer(hwnd, TIMER_ID, 1000, std::ptr::null());
                }
                h_clone.store(hwnd, Ordering::Release);
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
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                unsafe { drop(Box::from_raw(state_ptr)) };
            })
            .ok();
        Self {
            hwnd: hwnd_atomic,
            cancelled,
            committed,
            thread,
        }
    }

    pub fn set_stage(&self, text: &str) {
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd != 0 {
            let boxed = Box::new(to_wide(text));
            let ptr = Box::into_raw(boxed);
            if unsafe { PostMessageW(hwnd, WM_APP_STAGE, 0, ptr as isize) } == 0 {
                unsafe { drop(Box::from_raw(ptr)) };
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn enter_commit(&self) {
        self.committed.store(true, Ordering::Release);
        let hwnd = self.hwnd.load(Ordering::Acquire);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_COMMIT, 0, 0) };
        }
    }

    pub fn close(mut self) {
        let hwnd = self.hwnd.swap(0, Ordering::AcqRel);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_CLOSE, 0, 0) };
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for ProgressUi {
    fn drop(&mut self) {
        let hwnd = self.hwnd.swap(0, Ordering::AcqRel);
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_APP_CLOSE, 0, 0) };
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
