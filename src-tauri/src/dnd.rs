//! Turns on Windows' Do Not Disturb while The Pane runs (so notification
//! banners don't pop up), and puts the user's own setting back on exit.
//!
//! Windows has no public API for this. Do Not Disturb (called Focus Assist
//! on Windows 10) is the "quiet hours" profile, which Windows keeps in a WNF
//! state (a small system-wide value that the shell watches). We set that
//! state through ntdll, the same way the shell does:
//!   0 = off, 1 = priority only (Windows 11 Do Not Disturb), 2 = alarms only.
//!
//! As with the taskbar, the original value is saved to a file so it can be
//! restored on the next launch even if The Pane crashed.

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

/// WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED
const QUIET_HOURS_PROFILE: u64 = 0x0D83_063E_A3BF_1C75;
const PRIORITY_ONLY: u32 = 1;

static ON: AtomicBool = AtomicBool::new(false);

type NtQueryWnfStateData = unsafe extern "system" fn(
    state: *const u64,
    type_id: *const c_void,
    scope: *const c_void,
    change_stamp: *mut u32,
    buffer: *mut c_void,
    size: *mut u32,
) -> i32;

type NtUpdateWnfStateData = unsafe extern "system" fn(
    state: *const u64,
    buffer: *const c_void,
    size: u32,
    type_id: *const c_void,
    scope: *const c_void,
    matching_change_stamp: u32,
    check_stamp: u32,
) -> i32;

fn ntdll_fn(name: &[u8]) -> Option<unsafe extern "system" fn() -> isize> {
    let module: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    unsafe {
        let ntdll = GetModuleHandleW(module.as_ptr());
        if ntdll.is_null() {
            return None;
        }
        GetProcAddress(ntdll, name.as_ptr())
    }
}

/// The current quiet hours profile, if it can be read.
fn read() -> Option<u32> {
    let f = ntdll_fn(b"NtQueryWnfStateData\0")?;
    let query: NtQueryWnfStateData = unsafe { std::mem::transmute(f) };
    let mut stamp = 0u32;
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        query(
            &QUIET_HOURS_PROFILE,
            std::ptr::null(),
            std::ptr::null(),
            &mut stamp,
            &mut value as *mut u32 as *mut c_void,
            &mut size,
        )
    };
    // No data yet means it has never been turned on.
    (status >= 0).then_some(if size == 0 { 0 } else { value })
}

fn write(profile: u32) -> bool {
    let Some(f) = ntdll_fn(b"NtUpdateWnfStateData\0") else {
        return false;
    };
    let update: NtUpdateWnfStateData = unsafe { std::mem::transmute(f) };
    let status = unsafe {
        update(
            &QUIET_HOURS_PROFILE,
            &profile as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
            std::ptr::null(),
            std::ptr::null(),
            0,
            0,
        )
    };
    status >= 0
}

/// File holding the user's original setting while The Pane is running.
fn state_file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("dnd-state"))
}

fn saved() -> Option<u32> {
    state_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u32>().ok())
}

pub fn turn_on() {
    if ON.swap(true, Ordering::SeqCst) {
        return;
    }
    // If a previous run crashed, the file still holds the real original setting.
    let Some(original) = saved().or_else(read) else {
        eprintln!("The Pane: could not read the Do Not Disturb setting");
        ON.store(false, Ordering::SeqCst);
        return;
    };
    if let Some(p) = state_file() {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, original.to_string());
    }
    if original == 0 && !write(PRIORITY_ONLY) {
        eprintln!("The Pane: could not turn on Do Not Disturb");
    }
}

pub fn restore() {
    if !ON.swap(false, Ordering::SeqCst) {
        return;
    }
    let original = saved().unwrap_or(0);
    write(original);
    if let Some(p) = state_file() {
        let _ = std::fs::remove_file(p);
    }
}
