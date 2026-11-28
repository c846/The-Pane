//! The Windows shell (Explorer): stopped when The Pane starts, and started
//! again on demand from Pane settings ("Windows shell") for what only it can
//! do: the Settings app and other Store apps (Calculator, Photos, …), which
//! Windows can only show while Explorer is running as the shell.
//!
//! Windows 11 has no clean way to ask Explorer to exit (the old hidden "Exit
//! Explorer" command is gone), so it's ended outright. For it to stay gone,
//! Winlogon's AutoRestartShell (HKLM, machine-wide) must be 0; otherwise
//! Windows starts it again straight away.
//!
//! While Explorer runs it manages the desktop (taskbar, work area, minimized
//! windows). However it ends, The Pane takes the desktop back
//! (`desktop::reclaim`) and tells the pages ("windows-shell-changed").
//!
//! Quitting The Pane on purpose (Ctrl+Shift+Q) starts Explorer again if The
//! Pane stopped it, so the user is never left with nothing on screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId};

use crate::{apps, debug_log, desktop};

/// How long to wait for Explorer to finish exiting.
const EXIT_TIMEOUT: u32 = 5_000;
/// How long to wait for a started Explorer to show its taskbar.
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// After the taskbar appears, Explorer needs a moment more before it can
/// open Store apps.
const SETTLE: Duration = Duration::from_millis(1_500);

/// Whether The Pane stopped Explorer at startup (so quitting brings it back).
static STOPPED_AT_START: AtomicBool = AtomicBool::new(false);
/// Set while The Pane is starting Explorer, so it isn't started twice.
static STARTING: AtomicBool = AtomicBool::new(false);

/// Explorer's taskbar window, if Explorer is running as the shell.
fn taskbar() -> Option<HWND> {
    let class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    let h = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    (!h.is_null()).then_some(h)
}

pub fn is_running() -> bool {
    taskbar().is_some()
}

/// The shell's process, opened to wait on (and, with `terminate`, to end).
fn shell_process(terminate: bool) -> Option<HANDLE> {
    let tray = taskbar()?;
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(tray, &mut pid);
        let access = PROCESS_SYNCHRONIZE | if terminate { PROCESS_TERMINATE } else { 0 };
        let process = OpenProcess(access, 0, pid);
        (!process.is_null()).then_some(process)
    }
}

/// End Explorer if it's running as the shell. Blocks until it's gone.
fn end() -> bool {
    let Some(process) = shell_process(true) else {
        return false;
    };
    unsafe {
        TerminateProcess(process, 0);
        WaitForSingleObject(process, EXIT_TIMEOUT);
        CloseHandle(process);
    }
    true
}

/// At startup: end Explorer, so The Pane is the shell.
pub fn stop_at_start() {
    if end() {
        STOPPED_AT_START.store(true, Ordering::SeqCst);
    }
}

/// When quitting on purpose: start Explorer again, if The Pane stopped it.
pub fn restore() {
    if STOPPED_AT_START.swap(false, Ordering::SeqCst) && !is_running() {
        spawn_explorer();
    }
}

fn spawn_explorer() -> bool {
    match std::process::Command::new("explorer.exe").spawn() {
        Ok(_) => true,
        Err(e) => {
            debug_log::log(format!("Couldn't start Explorer: {e}"));
            false
        }
    }
}

/// Start Explorer as the shell and wait until it's ready (or give up).
/// Returns whether it's running. Then, in the background, waits for it to
/// end, however that happens, and takes the desktop back.
fn start_and_wait(app: &AppHandle) -> bool {
    if is_running() {
        return true;
    }
    if STARTING.swap(true, Ordering::SeqCst) {
        // Someone else is starting it; just wait.
        return wait_for_taskbar();
    }
    let ok = spawn_explorer() && wait_for_taskbar();
    STARTING.store(false, Ordering::SeqCst);
    if ok {
        let _ = app.emit("windows-shell-changed", true);
        watch_until_exit(app.clone());
        thread::sleep(SETTLE);
    }
    ok
}

fn wait_for_taskbar() -> bool {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if is_running() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    is_running()
}

fn watch_until_exit(app: AppHandle) {
    let Some(process) = shell_process(false) else {
        return;
    };
    let process = process as isize;
    thread::spawn(move || unsafe {
        WaitForSingleObject(process as HANDLE, INFINITE);
        CloseHandle(process as HANDLE);
        desktop::reclaim();
        let _ = app.emit("windows-shell-changed", false);
    });
}

/// Whether Explorer is running as the shell.
#[tauri::command]
pub fn windows_shell_running() -> bool {
    is_running()
}

/// Start Explorer as the shell (Pane settings).
#[tauri::command]
pub async fn start_windows_shell(app: AppHandle) -> Result<(), String> {
    let ok = tauri::async_runtime::spawn_blocking(move || start_and_wait(&app))
        .await
        .map_err(|e| e.to_string())?;
    ok.then_some(()).ok_or_else(|| "Windows didn't start the shell".into())
}

/// Stop Explorer again (Pane settings). The watcher started with it takes
/// the desktop back.
#[tauri::command]
pub async fn stop_windows_shell() {
    let _ = tauri::async_runtime::spawn_blocking(end).await;
}

/// Open the Settings app, starting the shell first if it isn't running.
#[tauri::command]
pub fn open_windows_settings(app: AppHandle) {
    if is_running() {
        apps::shell_open_from_pane(&app, "ms-settings:");
        return;
    }
    crate::pane::close(&app);
    thread::spawn(move || {
        if start_and_wait(&app) {
            apps::shell_open_from_pane(&app, "ms-settings:");
        }
    });
}
