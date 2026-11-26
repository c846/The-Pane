//! Only one copy of The Pane runs at a time (two would fight over the
//! keyboard hook, the Home hotkey and the taskbar).
//!
//! A newly started copy takes over: it asks the running one to quit (which
//! gives the user their taskbar back first) and waits for it to go. Started
//! with `--quit`, it does only that and exits; the installer and uninstaller
//! use this so the app is never killed outright while it hides the taskbar.

use std::sync::OnceLock;
use std::time::Duration;

use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, ResetEvent, SetEvent, WaitForSingleObject, INFINITE,
};

const RUNNING: &str = "Local\\ThePane.Running";
const QUIT: &str = "Local\\ThePane.Quit";
/// How long to wait for the running copy to quit.
const QUIT_TIMEOUT_MS: u32 = 5_000;

/// The quit signal, once this copy is the one running (a HANDLE as isize).
static QUIT_EVENT: OnceLock<isize> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn owned(wait: u32) -> bool {
    wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED
}

/// Call first thing in `main`. Returns whether this copy should go on to run.
pub fn claim() -> bool {
    let quit_only = std::env::args().any(|a| a == "--quit");
    unsafe {
        let running = CreateMutexW(std::ptr::null(), 0, wide(RUNNING).as_ptr());
        // Manual-reset: stays signalled until the next copy resets it.
        let quit: HANDLE = CreateEventW(std::ptr::null(), 1, 0, wide(QUIT).as_ptr());
        if running.is_null() || quit.is_null() {
            return !quit_only;
        }
        let mut mine = owned(WaitForSingleObject(running, 0));
        if !mine {
            // Another copy is running: ask it to quit, and wait until it has.
            SetEvent(quit);
            mine = owned(WaitForSingleObject(running, QUIT_TIMEOUT_MS));
        }
        if quit_only || !mine {
            return false;
        }
        // Owned by the main thread for the rest of the process's life (the
        // handle is never closed); released when the process ends.
        ResetEvent(quit);
        let _ = QUIT_EVENT.set(quit as isize);
        true
    }
}

/// Quit (tidily) when another copy asks to take over.
pub fn quit_when_asked(app: AppHandle) {
    let Some(&quit) = QUIT_EVENT.get() else {
        return;
    };
    std::thread::spawn(move || unsafe {
        WaitForSingleObject(quit as HANDLE, INFINITE);
        crate::restore_windows();
        app.exit(0);
        // If the event loop doesn't wind down promptly, don't keep the new
        // copy waiting; everything that matters is already restored.
        std::thread::sleep(Duration::from_secs(2));
        std::process::exit(0);
    });
}
