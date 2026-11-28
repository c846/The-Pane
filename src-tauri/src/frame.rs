//! Square corners and no outline on every app window.
//!
//! Windows 11 rounds window corners and draws a thin accent-colored border
//! around them. Both are DWM attributes that any process may set on any
//! top-level window, so we set them on each window that exists at startup
//! and on each new one as it appears. Apps that draw their own title bars
//! (browsers, Electron apps) are covered too; elevated windows are not,
//! since a normal process can't change them.

use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT,
    DWMWCP_DONOTROUND,
};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetMessageW, GetWindowThreadProcessId, CHILDID_SELF,
    EVENT_OBJECT_SHOW, GA_ROOT, MSG, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};

/// `DWMWA_COLOR_NONE`: draw no border at all.
const COLOR_NONE: u32 = 0xFFFF_FFFE;
/// `DWMWA_COLOR_DEFAULT`: the border Windows would normally draw.
const COLOR_DEFAULT: u32 = 0xFFFF_FFFF;

fn set(h: HWND, corners: i32, border: u32) {
    unsafe {
        DwmSetWindowAttribute(
            h,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corners as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        );
        DwmSetWindowAttribute(
            h,
            DWMWA_BORDER_COLOR as u32,
            &border as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

fn is_ours(h: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, &mut pid) };
    pid == std::process::id()
}

fn for_each_window(f: fn(HWND)) {
    unsafe extern "system" fn visit(h: HWND, f: LPARAM) -> windows_sys::core::BOOL {
        if !is_ours(h) {
            let f: fn(HWND) = std::mem::transmute(f);
            f(h);
        }
        1
    }
    unsafe { EnumWindows(Some(visit), f as usize as LPARAM) };
}

fn flatten(h: HWND) {
    set(h, DWMWCP_DONOTROUND, COLOR_NONE);
}

unsafe extern "system" fn on_show(
    _hook: HWINEVENTHOOK,
    _event: u32,
    h: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    // Only whole top-level windows, not controls inside them.
    if object != OBJID_WINDOW || child != CHILDID_SELF as i32 || h.is_null() {
        return;
    }
    if GetAncestor(h, GA_ROOT) != h {
        return;
    }
    flatten(h);
}

/// Flatten every window now, and every window shown from here on.
pub fn start() {
    std::thread::spawn(|| unsafe {
        for_each_window(flatten);
        // Out-of-context hooks are called on this thread, so it needs a
        // message loop. Our own windows are left as they are.
        let hook = SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_SHOW,
            std::ptr::null_mut(),
            Some(on_show),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if hook.is_null() {
            crate::debug_log::log("frame: could not install the window hook".to_string());
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
    });
}

/// Give every window its normal rounded corners and border back.
pub fn restore() {
    for_each_window(|h| set(h, DWMWCP_DEFAULT, COLOR_DEFAULT));
}
