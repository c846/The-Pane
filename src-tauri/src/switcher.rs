//! The Alt+Space window switcher (replaces Alt+Tab).
//!
//! keyboard.rs turns key presses into calls here: `start` on Alt+Space,
//! `step` on each further Space, `finish` when Alt is let go, `cancel` on Esc.
//! The pane glances open (see pane.rs) and the page lists the windows
//! ("switcher-open"), moving the highlight on "switcher-select". It fetches
//! each window's icon and preview with `window_icon` / `window_preview`.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt, HALFTONE, SRCCOPY,
};
use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows_sys::Win32::Storage::Xps::PrintWindow;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetClassLongPtrW, GetClassNameW, GetWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, SendMessageTimeoutW, GCLP_HICON, GWL_EXSTYLE, GW_OWNER, HICON, ICON_BIG,
    PW_RENDERFULLCONTENT, SMTO_ABORTIFHUNG, WM_GETICON, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

use crate::pane::{self, Glance};
use crate::{apps, win};

/// Previews are scaled down to fit this (physical px).
const PREVIEW_MAX: (i32, i32) = (640, 400);

#[derive(Clone, Serialize)]
pub struct WindowInfo {
    id: isize,
    /// The app's name, e.g. "Google Chrome".
    name: String,
    /// The window's title (often includes the document or page).
    title: String,
}

struct State {
    active: bool,
    windows: Vec<isize>,
    selected: usize,
}

static STATE: Mutex<State> = Mutex::new(State { active: false, windows: Vec::new(), selected: 0 });

#[derive(Clone, Serialize)]
struct Opening {
    windows: Vec<WindowInfo>,
    selected: usize,
}

pub fn start(app: &AppHandle, back: bool) {
    if pane::is_open() {
        return;
    }
    let list = list_windows();
    if list.is_empty() {
        return;
    }
    // Like Alt+Tab, start on the window behind the current one.
    let n = list.len();
    let selected = if back { n - 1 } else { 1.min(n - 1) };
    {
        let mut s = STATE.lock().unwrap();
        s.active = true;
        s.windows = list.iter().map(|w| w.id).collect();
        s.selected = selected;
    }
    if !pane::glance(app, Glance::Switcher) {
        STATE.lock().unwrap().active = false;
        return;
    }
    let _ = app.emit_to("pane", "switcher-open", Opening { windows: list, selected });
}

pub fn step(app: &AppHandle, back: bool) {
    let mut s = STATE.lock().unwrap();
    let n = s.windows.len();
    if !s.active || n == 0 {
        return;
    }
    s.selected = if back { (s.selected + n - 1) % n } else { (s.selected + 1) % n };
    let _ = app.emit_to("pane", "switcher-select", s.selected);
}

/// Alt let go: switch to the selected window.
pub fn finish(app: &AppHandle) {
    let target = {
        let mut s = STATE.lock().unwrap();
        if !std::mem::replace(&mut s.active, false) {
            return;
        }
        s.windows.get(s.selected).copied()
    };
    // The pane may have been opened in the meantime; then leave it be.
    if !pane::is_glancing(Glance::Switcher) {
        return;
    }
    pane::unglance(app, Glance::Switcher);
    if let Some(h) = target {
        win::activate_any(h);
    }
}

pub fn cancel(app: &AppHandle) {
    STATE.lock().unwrap().active = false;
    pane::unglance(app, Glance::Switcher);
}

// ---- Which windows -----------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 128];
    let len = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn title(h: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(h);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let got = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }
}

/// The same windows Alt+Tab would list.
fn is_switchable(h: HWND) -> bool {
    unsafe {
        if IsWindowVisible(h) == 0 || h as isize == pane::hwnd() {
            return false;
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let app_window = ex & WS_EX_APPWINDOW != 0;
        if !app_window && (!GetWindow(h, GW_OWNER).is_null() || ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) != 0) {
            return false;
        }
        // Cloaked: on another virtual desktop, or a suspended Store app.
        let mut cloaked = 0u32;
        let ok = DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if ok >= 0 && cloaked != 0 {
            return false;
        }
        if GetWindowTextLengthW(h) == 0 {
            return false;
        }
        !matches!(class_name(h).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
    }
}

/// Switchable windows, the one in front first, then the rest front to back.
fn list_windows() -> Vec<WindowInfo> {
    unsafe extern "system" fn collect(h: HWND, list: LPARAM) -> windows_sys::core::BOOL {
        if is_switchable(h) {
            (*(list as *mut Vec<isize>)).push(h as isize);
        }
        1
    }
    let mut handles: Vec<isize> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut handles as *mut _ as LPARAM);
    }
    // Always-on-top windows come first in z-order even when not in front.
    let front = win::foreground();
    if let Some(i) = handles.iter().position(|&h| h == front) {
        let h = handles.remove(i);
        handles.insert(0, h);
    }
    handles
        .into_iter()
        .map(|id| {
            let title = title(id as HWND);
            let name = app_name(id as HWND, &title);
            WindowInfo { id, name, title }
        })
        .collect()
}

fn exe_path(h: HWND) -> Option<String> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The app's name: its program's description (what Task Manager shows),
/// else the program's file name. Store apps are all hosted by one program,
/// but their window title is the app's name.
fn app_name(h: HWND, title: &str) -> String {
    static NAMES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    let Some(path) = exe_path(h) else {
        return title.to_string();
    };
    let stem = std::path::Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if stem.eq_ignore_ascii_case("ApplicationFrameHost") {
        return title.to_string();
    }
    let mut names = NAMES.lock().unwrap();
    names
        .get_or_insert_with(HashMap::new)
        .entry(path.clone())
        .or_insert_with(|| file_description(&path).unwrap_or(stem))
        .clone()
}

fn file_description(path: &str) -> Option<String> {
    unsafe {
        let file = wide(path);
        let size = GetFileVersionInfoSizeW(file.as_ptr(), std::ptr::null_mut());
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(file.as_ptr(), 0, size, data.as_mut_ptr() as *mut _) == 0 {
            return None;
        }
        let query = |key: &str| -> Option<(*mut std::ffi::c_void, u32)> {
            let key = wide(key);
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            (VerQueryValueW(data.as_ptr() as *const _, key.as_ptr(), &mut ptr, &mut len) != 0 && len > 0)
                .then_some((ptr, len))
        };
        // The first language the file has strings in, then US English.
        let mut languages = Vec::new();
        if let Some((ptr, len)) = query("\\VarFileInfo\\Translation") {
            if len >= 4 {
                let pair = std::slice::from_raw_parts(ptr as *const u16, 2);
                languages.push(format!("{:04x}{:04x}", pair[0], pair[1]));
            }
        }
        languages.push("040904b0".into());
        languages.push("040904e4".into());
        for lang in languages {
            if let Some((ptr, len)) = query(&format!("\\StringFileInfo\\{lang}\\FileDescription")) {
                let text = std::slice::from_raw_parts(ptr as *const u16, len as usize);
                let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
                let name = String::from_utf16_lossy(&text[..end]).trim().to_string();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        None
    }
}

// ---- Icons and previews ---------------------------------------------------------

/// Only windows in the switcher's current list can be asked about.
fn listed(id: isize) -> bool {
    STATE.lock().unwrap().windows.contains(&id)
}

/// A window's icon as raw RGBA pixels (square, like `app_icon`). Empty if none.
#[tauri::command]
pub async fn window_icon(id: isize) -> Response {
    if !listed(id) {
        return Response::new(Vec::new());
    }
    let pixels = tauri::async_runtime::spawn_blocking(move || unsafe {
        let h = id as HWND;
        let mut icon: usize = 0;
        SendMessageTimeoutW(h, WM_GETICON, ICON_BIG as usize, 0, SMTO_ABORTIFHUNG, 100, &mut icon);
        if icon == 0 {
            icon = GetClassLongPtrW(h, GCLP_HICON);
        }
        if icon != 0 {
            // Owned by the window; not ours to destroy.
            return apps::hicon_to_rgba(icon as HICON).unwrap_or_default();
        }
        // Fall back to the program's own icon.
        let Some(path) = exe_path(h) else {
            return Vec::new();
        };
        let file = wide(&path);
        let mut info: SHFILEINFOW = std::mem::zeroed();
        let size = std::mem::size_of::<SHFILEINFOW>() as u32;
        if SHGetFileInfoW(file.as_ptr(), 0, &mut info, size, SHGFI_ICON | SHGFI_LARGEICON) == 0 || info.hIcon.is_null() {
            return Vec::new();
        }
        let pixels = apps::hicon_to_rgba(info.hIcon).unwrap_or_default();
        DestroyIcon(info.hIcon);
        pixels
    })
    .await
    .unwrap_or_default();
    Response::new(pixels)
}

/// A snapshot of the window, scaled down: width and height (u32, little
/// endian) followed by RGBA pixels. Empty if there is none (e.g. minimised).
#[tauri::command]
pub async fn window_preview(id: isize) -> Response {
    if !listed(id) {
        return Response::new(Vec::new());
    }
    let data = tauri::async_runtime::spawn_blocking(move || {
        capture(id as HWND)
            .map(|(w, h, px)| {
                let mut out = Vec::with_capacity(8 + px.len());
                out.extend_from_slice(&(w as u32).to_le_bytes());
                out.extend_from_slice(&(h as u32).to_le_bytes());
                out.extend_from_slice(&px);
                out
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    Response::new(data)
}

fn capture(h: HWND) -> Option<(i32, i32, Vec<u8>)> {
    unsafe {
        if IsIconic(h) != 0 {
            return None;
        }
        let mut outer: RECT = std::mem::zeroed();
        if GetWindowRect(h, &mut outer) == 0 {
            return None;
        }
        // The visible frame (the window rect includes invisible resize borders).
        let mut frame = outer;
        DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut frame as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        );
        let (w, hgt) = (outer.right - outer.left, outer.bottom - outer.top);
        let cx = (frame.left - outer.left).clamp(0, w);
        let cy = (frame.top - outer.top).clamp(0, hgt);
        let cw = (frame.right - frame.left).min(w - cx);
        let ch = (frame.bottom - frame.top).min(hgt - cy);
        if w <= 0 || hgt <= 0 || cw <= 0 || ch <= 0 {
            return None;
        }
        let scale = (PREVIEW_MAX.0 as f64 / cw as f64).min(PREVIEW_MAX.1 as f64 / ch as f64).min(1.0);
        let tw = ((cw as f64 * scale).round() as i32).max(1);
        let th = ((ch as f64 * scale).round() as i32).max(1);

        let screen = GetDC(std::ptr::null_mut());
        let full_dc = CreateCompatibleDC(screen);
        let full = CreateCompatibleBitmap(screen, w, hgt);
        let old_full = SelectObject(full_dc, full as _);
        let printed = PrintWindow(h, full_dc, PW_RENDERFULLCONTENT) != 0;

        let thumb_dc = CreateCompatibleDC(screen);
        let thumb = CreateCompatibleBitmap(screen, tw, th);
        let old_thumb = SelectObject(thumb_dc, thumb as _);
        if printed {
            SetStretchBltMode(thumb_dc, HALFTONE);
            SetBrushOrgEx(thumb_dc, 0, 0, std::ptr::null_mut());
            StretchBlt(thumb_dc, 0, 0, tw, th, full_dc, cx, cy, cw, ch, SRCCOPY);
        }
        SelectObject(thumb_dc, old_thumb);
        SelectObject(full_dc, old_full);
        DeleteDC(thumb_dc);
        DeleteDC(full_dc);
        DeleteObject(full as _);
        ReleaseDC(std::ptr::null_mut(), screen);

        let pixels = if printed { apps::bitmap_bgra(thumb, tw, th) } else { None };
        DeleteObject(thumb as _);
        let mut px = pixels?;
        // Some apps (e.g. games) can't be captured and come back black.
        if px.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0) {
            return None;
        }
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2); // BGRA -> RGBA
            p[3] = 255;
        }
        Some((tw, th, px))
    }
}
