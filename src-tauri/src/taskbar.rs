//! Hides the Windows taskbar while The Pane runs and restores it on exit.
//!
//! The taskbar is switched to auto-hide (so Windows itself gives maximised apps
//! the full screen) and its windows are hidden (so it never slides back in).
//! The user's original auto-hide setting is saved to a file, so it can be put
//! back on the next launch even if The Pane crashed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::UI::Shell::{
    SHAppBarMessage, ABM_GETSTATE, ABM_SETSTATE, ABS_AUTOHIDE, APPBARDATA,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClassNameW, IsWindowVisible, ShowWindow, SW_HIDE, SW_SHOW,
};

static HIDDEN: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam as *mut Vec<isize>);
    let mut buf = [0u16; 64];
    let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if len > 0 {
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        if class == "Shell_TrayWnd" || class == "Shell_SecondaryTrayWnd" {
            list.push(hwnd as isize);
        }
    }
    1
}

/// The main taskbar plus the taskbars on any secondary monitors.
fn taskbars() -> Vec<isize> {
    let mut list: Vec<isize> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut list as *mut _ as LPARAM);
    }
    list
}

fn appbar_data() -> APPBARDATA {
    let class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    let mut abd: APPBARDATA = unsafe { std::mem::zeroed() };
    abd.cbSize = std::mem::size_of::<APPBARDATA>() as u32;
    abd.hWnd = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    abd
}

fn get_state() -> u32 {
    let mut abd = appbar_data();
    unsafe { SHAppBarMessage(ABM_GETSTATE, &mut abd) as u32 }
}

fn set_state(state: u32) {
    let mut abd = appbar_data();
    abd.lParam = state as LPARAM;
    unsafe {
        SHAppBarMessage(ABM_SETSTATE, &mut abd);
    }
}

/// File holding the user's original taskbar state while The Pane is running.
fn state_file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("taskbar-state"))
}

pub fn hide() {
    if HIDDEN.swap(true, Ordering::SeqCst) {
        return;
    }
    // If a previous run crashed, the file still holds the real original state.
    let saved = state_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u32>().ok());
    let original = saved.unwrap_or_else(get_state);
    if let Some(p) = state_file() {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, original.to_string());
    }
    set_state(original | ABS_AUTOHIDE);
    enforce();
}

/// Called periodically: Explorer sometimes brings the taskbar back on its own.
pub fn enforce() {
    if !HIDDEN.load(Ordering::SeqCst) {
        return;
    }
    for h in taskbars() {
        unsafe {
            if IsWindowVisible(h as HWND) != 0 {
                ShowWindow(h as HWND, SW_HIDE);
            }
        }
    }
}

pub fn restore() {
    if !HIDDEN.swap(false, Ordering::SeqCst) {
        return;
    }
    let original = state_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    set_state(original);
    for h in taskbars() {
        unsafe {
            ShowWindow(h as HWND, SW_SHOW);
        }
    }
    if let Some(p) = state_file() {
        let _ = std::fs::remove_file(p);
    }
}
