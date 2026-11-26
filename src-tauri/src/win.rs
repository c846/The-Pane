//! Thin wrappers around the raw Win32 calls the app needs.
//! Window handles are passed around as `isize` so they can live in atomics.

use std::sync::OnceLock;

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, POINT};
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC, VK_LBUTTON, VK_LMENU, VK_MENU,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, IsWindow, SetForegroundWindow,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, SystemParametersInfoW, GWL_EXSTYLE, HWND_TOPMOST,
    SPI_GETDESKWALLPAPER, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

fn hwnd(h: isize) -> HWND {
    h as HWND
}

static APP_COMMAND: OnceLock<fn(u32) -> bool> = OnceLock::new();

/// Hand the window's WM_APPCOMMAND messages (media and volume keys, mouse
/// back/forward buttons, …) to `f` first, by command number. If it returns
/// true the command is handled, and Windows never sees it. Must be called
/// on the thread that owns the window.
///
/// Keys pressed while our window has the keyboard can reach it without
/// passing the keyboard hook; left alone, its volume keys would end up
/// with Windows and show Windows' volume popup.
pub fn on_app_command(h: isize, f: fn(u32) -> bool) {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    let _ = APP_COMMAND.set(f);
    unsafe {
        let ok = SetWindowSubclass(hwnd(h), Some(app_command_proc), 1, 0);
        crate::debug_log::log(format!("app command catcher installed: {}", ok != 0));
    }
}

unsafe extern "system" fn app_command_proc(
    h: HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _id: usize,
    _data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::WM_APPCOMMAND;
    if msg == WM_APPCOMMAND {
        // GET_APPCOMMAND_LPARAM: the high word, minus the device bits.
        let command = ((lparam as usize >> 16) as u16 & !0xF000) as u32;
        if APP_COMMAND.get().is_some_and(|f| f(command)) {
            return 1;
        }
    }
    DefSubclassProc(h, msg, wparam, lparam)
}

/// Turn a window into a tool window (hidden from Alt+Tab and the taskbar).
/// Optionally make it never take focus.
pub fn make_tool_window(h: isize, no_activate: bool) {
    unsafe {
        let mut style = GetWindowLongPtrW(hwnd(h), GWL_EXSTYLE) as u32;
        style |= WS_EX_TOOLWINDOW;
        style &= !WS_EX_APPWINDOW;
        if no_activate {
            style |= WS_EX_NOACTIVATE;
        }
        SetWindowLongPtrW(hwnd(h), GWL_EXSTYLE, style as isize);
    }
}

/// Let mouse clicks pass straight through a window to whatever is behind it
/// (or stop doing so). Same styles Tauri uses for `set_ignore_cursor_events`;
/// done directly so Tauri's idea of the window's state isn't disturbed.
pub fn set_click_through(h: isize, on: bool) {
    if h == 0 {
        return;
    }
    unsafe {
        let old = GetWindowLongPtrW(hwnd(h), GWL_EXSTYLE) as u32;
        let style = if on {
            old | WS_EX_TRANSPARENT | WS_EX_LAYERED
        } else {
            old & !(WS_EX_TRANSPARENT | WS_EX_LAYERED)
        };
        if style != old {
            SetWindowLongPtrW(hwnd(h), GWL_EXSTYLE, style as isize);
            SetWindowPos(
                hwnd(h),
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }
}

/// Bring our own window to the front and give it the keyboard. Windows only
/// lets the app that last had input do that, so if it refuses, a tap of Alt
/// (as Tauri's own set_focus does) earns the right first.
pub fn force_foreground(h: isize) {
    if h == 0 {
        return;
    }
    unsafe {
        if GetForegroundWindow() == hwnd(h) || SetForegroundWindow(hwnd(h)) != 0 {
            return;
        }
        let scan = MapVirtualKeyW(VK_MENU as u32, MAPVK_VK_TO_VSC) as u16;
        let mut inputs: [INPUT; 2] = std::mem::zeroed();
        for (i, input) in inputs.iter_mut().enumerate() {
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki.wVk = VK_LMENU;
            input.Anonymous.ki.wScan = scan;
            input.Anonymous.ki.dwExtraInfo = crate::keyboard::OUR_INPUT;
            input.Anonymous.ki.dwFlags =
                KEYEVENTF_EXTENDEDKEY | if i == 1 { KEYEVENTF_KEYUP } else { 0 };
        }
        SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        SetForegroundWindow(hwnd(h));
    }
}

/// Turn off the fade/zoom animation Windows plays when a window is shown or hidden.
pub fn disable_transitions(h: isize) {
    let disabled: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            hwnd(h),
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

/// Show a window at the given physical rect, topmost, without stealing focus.
pub fn show_at_no_activate(h: isize, x: i32, y: i32, w: i32, height: i32) {
    unsafe {
        SetWindowPos(
            hwnd(h),
            HWND_TOPMOST,
            x,
            y,
            w,
            height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

pub fn hide(h: isize) {
    unsafe {
        ShowWindow(hwnd(h), SW_HIDE);
    }
}

/// Bring a window to the front (if it still exists).
pub fn activate(h: isize) {
    unsafe {
        if IsWindow(hwnd(h)) != 0 {
            SetForegroundWindow(hwnd(h));
        }
    }
}

/// Bring another app's window to the front (restoring it if minimised), as
/// Alt+Tab does. Windows only lets the app in front hand over the
/// foreground, so this borrows its input queue for a moment.
pub fn activate_any(h: isize) {
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{BringWindowToTop, GetWindowThreadProcessId, IsIconic, SW_RESTORE};
    unsafe {
        if IsWindow(hwnd(h)) == 0 {
            return;
        }
        if IsIconic(hwnd(h)) != 0 {
            ShowWindow(hwnd(h), SW_RESTORE);
        }
        let front_thread = GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
        let me = GetCurrentThreadId();
        let attached = front_thread != 0 && front_thread != me && AttachThreadInput(me, front_thread, 1) != 0;
        BringWindowToTop(hwnd(h));
        SetForegroundWindow(hwnd(h));
        if attached {
            AttachThreadInput(me, front_thread, 0);
        }
    }
    if foreground() != h {
        force_foreground(h);
    }
}

/// Full path of the current desktop wallpaper image, if there is one.
pub fn wallpaper_path() -> Option<String> {
    let mut buf = [0u16; 1024];
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            buf.as_mut_ptr() as *mut _,
            0,
        )
    };
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    (ok != 0 && len > 0).then(|| String::from_utf16_lossy(&buf[..len]))
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow() as isize }
}

pub fn cursor_pos()-> Option<(i32, i32)> {
    let mut pt = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut pt) };
    (ok != 0).then_some((pt.x, pt.y))
}

pub fn left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}


static CONSOLE_CLOSE: OnceLock<fn()> = OnceLock::new();

unsafe extern "system" fn console_handler(_ctrl_type: u32) -> BOOL {
    if let Some(f) = CONSOLE_CLOSE.get() {
        f();
    }
    0 // let the default handler terminate the process
}

/// Run `f` when the console is closed or Ctrl+C is pressed (useful in dev).
pub fn on_console_close(f: fn()) {
    let _ = CONSOLE_CLOSE.set(f);
    unsafe {
        SetConsoleCtrlHandler(Some(console_handler), 1);
    }
}
