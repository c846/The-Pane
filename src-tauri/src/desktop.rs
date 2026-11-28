//! The desktop under the apps. Explorer is stopped first (see explorer.rs);
//! with no Windows shell running, nobody else looks after these:
//!
//! - The desktop window ("desktop", src/widgets): the wallpaper and widgets,
//!   covering the screen, always behind every app and never taking focus.
//! - Maximized windows fill the whole screen (see `watch`).
//! - Minimized windows are hidden (see `watch`).
//! - The wallpaper can be picked from the settings (`pick_wallpaper`). It's
//!   saved as the Windows wallpaper, so it stays the one source of truth;
//!   when it changes (from anywhere), the windows are told
//!   ("wallpaper-changed").

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::OnceLock;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SystemParametersInfoW, ARW_HIDE, HWND_BOTTOM, MINIMIZEDMETRICS, SPIF_SENDCHANGE,
    SPIF_UPDATEINIFILE, SPI_GETMINIMIZEDMETRICS, SPI_SETDESKWALLPAPER, SPI_SETMINIMIZEDMETRICS,
    SPI_SETWORKAREA, SWP_NOACTIVATE, SWP_SHOWWINDOW,
};

use crate::{explorer, pane, win};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Call once at startup: shows the desktop window, stops Explorer, then
/// keeps the desktop right. The watching runs on a thread of its own, since
/// Explorer can take a moment to exit and the watching needs a message loop.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let Some(h) = desktop_hwnd() {
        // Out of Alt+Space and the way of focus: clicking it leaves the
        // current app in front.
        win::make_tool_window(h, true);
        win::disable_transitions(h);
    }
    place_desktop_window();
    std::thread::spawn(|| {
        explorer::stop_at_start();
        set_minimized_metrics();
        watch();
    });
}

fn desktop_hwnd() -> Option<isize> {
    let window = APP.get()?.get_webview_window("desktop")?;
    Some(window.hwnd().ok()?.0 as isize)
}

/// Cover the primary screen, behind every other window. (The window is also
/// "always on bottom", so it stays there.)
fn place_desktop_window() {
    let (Some(app), Some(h)) = (APP.get(), desktop_hwnd()) else {
        return;
    };
    let Ok(Some(m)) = app.primary_monitor() else {
        return;
    };
    let (pos, size) = (m.position(), m.size());
    unsafe {
        SetWindowPos(
            h as HWND,
            HWND_BOTTOM,
            pos.x,
            pos.y,
            size.width as i32,
            size.height as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
}

/// Keep the desktop right for as long as The Pane runs:
/// - The Pane registers as the shell's task manager window, as Explorer
///   does. Windows only honours "hide minimized windows" (ARW_HIDE) while
///   one is registered; with none, it keeps minimized windows on screen as
///   small title bars (since nothing else could bring them back).
/// - Each screen's work area (the part maximized windows fill) is the whole
///   screen. Explorer reserves a strip for the taskbar and, when it's ended,
///   never gives it back. Re-checked only when Windows says the screens or
///   a work area changed, so nothing runs in between.
/// The hidden task window (see `create_task_window`), once created.
static TASK_WINDOW: AtomicIsize = AtomicIsize::new(0);

/// Take the desktop back after Explorer ran as the shell (started from Pane
/// settings): it changed the work area, minimized-window handling and task
/// manager window, and never undoes them when it's ended.
pub fn reclaim() {
    set_minimized_metrics();
    full_screen_work_areas();
    let h = TASK_WINDOW.load(Ordering::SeqCst);
    if h != 0 {
        unsafe { set_taskman_window(h as HWND) };
    }
    place_desktop_window();
}

fn watch() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, RegisterShellHookWindow, MSG,
    };

    full_screen_work_areas();
    unsafe {
        let task_window = create_task_window();
        if task_window.is_null() {
            crate::debug_log::log("Couldn't create the task window");
            return;
        }
        TASK_WINDOW.store(task_window as isize, Ordering::SeqCst);
        RegisterShellHookWindow(task_window);
        set_taskman_window(task_window);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn task_window_proc(h: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_DISPLAYCHANGE, WM_SETTINGCHANGE};
    match msg {
        WM_DISPLAYCHANGE => {
            full_screen_work_areas();
            place_desktop_window();
        }
        WM_SETTINGCHANGE if wparam == SPI_SETWORKAREA as usize => full_screen_work_areas(),
        WM_SETTINGCHANGE if wparam == SPI_SETDESKWALLPAPER as usize => {
            if let Some(app) = APP.get() {
                let _ = app.emit("wallpaper-changed", ());
            }
        }
        _ => {}
    }
    DefWindowProcW(h, msg, wparam, lparam)
}

/// A hidden window: Windows sends it shell notifications (window created,
/// activated, minimized, …; nothing is done with them yet) and broadcasts
/// display and setting changes.
unsafe fn create_task_window() -> HWND {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, RegisterClassW, WNDCLASSW, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    let class: Vec<u16> = "ThePane.TaskWindow\0".encode_utf16().collect();
    let instance = GetModuleHandleW(std::ptr::null());
    let mut wc: WNDCLASSW = std::mem::zeroed();
    wc.lpfnWndProc = Some(task_window_proc);
    wc.hInstance = instance;
    wc.lpszClassName = class.as_ptr();
    RegisterClassW(&wc);
    CreateWindowExW(
        WS_EX_TOOLWINDOW,
        class.as_ptr(),
        class.as_ptr(),
        WS_POPUP,
        0,
        0,
        0,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        instance,
        std::ptr::null(),
    )
}

/// user32's SetTaskmanWindow: undocumented (so not in the bindings), but
/// it's how a shell tells Windows it manages the open windows.
unsafe fn set_taskman_window(h: HWND) {
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    type SetTaskmanWindow = unsafe extern "system" fn(HWND) -> i32;
    let user32: Vec<u16> = "user32.dll\0".encode_utf16().collect();
    let module = GetModuleHandleW(user32.as_ptr());
    if module.is_null() {
        return;
    }
    if let Some(f) = GetProcAddress(module, b"SetTaskmanWindow\0".as_ptr()) {
        let f: SetTaskmanWindow = std::mem::transmute(f);
        if f(h) == 0 {
            crate::debug_log::log("SetTaskmanWindow failed");
        }
    }
}

/// Make every screen's work area the whole screen. Not while Explorer is
/// running: its taskbar needs the space.
fn full_screen_work_areas() {
    if explorer::is_running() {
        return;
    }
    unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, _: LPARAM) -> windows_sys::core::BOOL {
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(m, &mut info) != 0 {
            let (w, s) = (info.rcWork, info.rcMonitor);
            if (w.left, w.top, w.right, w.bottom) != (s.left, s.top, s.right, s.bottom) {
                let mut full = s;
                SystemParametersInfoW(SPI_SETWORKAREA, 0, &mut full as *mut _ as *mut _, SPIF_SENDCHANGE);
            }
        }
        1
    }
    unsafe {
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(each), 0);
    }
}

fn set_minimized_metrics() {
    unsafe {
        let mut metrics: MINIMIZEDMETRICS = std::mem::zeroed();
        metrics.cbSize = std::mem::size_of::<MINIMIZEDMETRICS>() as u32;
        let ptr = &mut metrics as *mut _ as *mut _;
        if SystemParametersInfoW(SPI_GETMINIMIZEDMETRICS, metrics.cbSize, ptr, 0) == 0 {
            return;
        }
        metrics.iArrange |= ARW_HIDE;
        SystemParametersInfoW(SPI_SETMINIMIZEDMETRICS, metrics.cbSize, ptr, 0);
    }
}

/// Make an image the Windows wallpaper, saved and announced to every window
/// (which is how the desktop window hears about it).
fn set_wallpaper(path: &str) -> bool {
    let mut wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let flags = SPIF_UPDATEINIFILE | SPIF_SENDCHANGE;
    unsafe { SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, wide.as_mut_ptr() as *mut _, flags) != 0 }
}

/// No wallpaper at all (a fresh install): the desktop and the pane show
/// solid white.
pub fn clear_wallpaper() {
    set_wallpaper("");
}

/// Identifies the current wallpaper (path + last-modified time), so the page
/// only reloads the image when it actually changed. Empty if there is none.
/// The desktop never takes focus, except while a widget on it is being typed
/// in (a note): `on` lets it take the keyboard, and `off` (when the typing
/// is over, e.g. another app was clicked) goes back to never taking focus.
/// The window stays behind every app either way ("always on bottom").
#[tauri::command]
pub fn desktop_keyboard(on: bool) {
    let Some(h) = desktop_hwnd() else {
        return;
    };
    win::set_no_activate(h, !on);
    if on {
        win::force_foreground(h);
    }
}

#[tauri::command]
pub fn wallpaper_key() -> String {
    let Some(path) = win::wallpaper_path() else {
        return String::new();
    };
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    format!("{path}|{modified}")
}

/// The wallpaper image file's bytes. Empty if there is none.
#[tauri::command]
pub fn get_wallpaper() -> Response {
    let data = win::wallpaper_path()
        .and_then(|p| std::fs::read(p).ok())
        .unwrap_or_default();
    Response::new(data)
}

/// Let the user pick an image file and make it the wallpaper. Returns false
/// if they cancelled.
#[tauri::command]
pub async fn pick_wallpaper() -> Result<bool, String> {
    let owner = pane::hwnd();
    pane::hold_open(true);
    // The picker runs its own message loop, so it gets a thread of its own.
    let picked = tauri::async_runtime::spawn_blocking(move || choose_image(owner))
        .await
        .map_err(|e| e.to_string());
    pane::hold_open(false);
    win::force_foreground(owner);

    let Some(path) = picked? else {
        return Ok(false);
    };
    if set_wallpaper(&path) {
        Ok(true)
    } else {
        Err("Windows couldn't use that image as the wallpaper".into())
    }
}

/// Shows the Windows "Open" dialog for images. The chosen file's path, or
/// None if cancelled.
fn choose_image(owner: isize) -> Option<String> {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, SIGDN_FILESYSPATH,
    };

    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let result = (|| -> windows::core::Result<String> {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetTitle(w!("Choose a wallpaper"))?;
            dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("Images"),
                pszSpec: w!("*.jpg;*.jpeg;*.jfif;*.png;*.bmp"),
            }])?;
            dialog.SetOptions(dialog.GetOptions()? | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM)?;
            dialog.Show(Some(HWND(owner as *mut _)))?; // fails if cancelled
            let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = name.to_string();
            CoTaskMemFree(Some(name.0 as *const _));
            Ok(path?)
        })();
        if initialized {
            CoUninitialize();
        }
        result.ok()
    }
}
