//! Installed apps: listing, icons and launching (used by the search bar).
//!
//! The list comes from the same place as the Start menu's "All apps"
//! (`Get-StartApps`), so it covers both classic programs and Store apps.
//! Every app is identified by its AppID and launched through
//! `shell:AppsFolder\<AppID>`, which works the same for both kinds.

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::AppHandle;
use windows_sys::core::GUID;
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::UI::Shell::Common::ITEMIDLIST;
use windows_sys::Win32::UI::Shell::{
    SHGetFileInfoW, SHGetImageList, SHParseDisplayName, ShellExecuteW, SHFILEINFOW, SHGFI_ICON,
    SHGFI_LARGEICON, SHGFI_PIDL, SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, DestroyIcon, GetIconInfo, ASFW_ANY, HICON, ICONINFO, SW_SHOWNORMAL,
};

use crate::{library, pane};

/// Don't re-read the app list more often than this.
const REFRESH_EVERY: Duration = Duration::from_secs(60);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize)]
pub struct App {
    pub name: String,
    pub id: String,
}

struct Cache {
    apps: Vec<App>,
    loaded_at: Option<Instant>,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache { apps: Vec::new(), loaded_at: None });
/// Held while the list is being read, so only one read runs at a time.
static LOADING: Mutex<()> = Mutex::new(());

fn read_start_apps() -> Option<Vec<App>> {
    let script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
                  Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress";
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    // A single app comes back as an object rather than a list.
    let items = match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    };

    let mut apps: Vec<App> = Vec::new();
    for item in items {
        let (Some(name), Some(id)) = (item["Name"].as_str(), item["AppID"].as_str()) else {
            continue;
        };
        let lower_name = name.to_lowercase();
        let lower_id = id.to_lowercase();
        // Skip uninstallers and plain web links that some programs put in the Start menu.
        if name.trim().is_empty()
            || lower_name.starts_with("uninstall")
            || lower_id.starts_with("http:")
            || lower_id.starts_with("https:")
        {
            continue;
        }
        if apps.iter().any(|a| a.id.eq_ignore_ascii_case(id) || a.name.eq_ignore_ascii_case(name)) {
            continue;
        }
        apps.push(App { name: name.to_string(), id: id.to_string() });
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    Some(apps)
}

/// Re-read the app list (blocking). Skipped if it was read recently, unless `force`.
fn reload(force: bool) {
    let _guard = LOADING.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = CACHE
        .lock()
        .unwrap()
        .loaded_at
        .is_some_and(|t| t.elapsed() < REFRESH_EVERY);
    if fresh && !force {
        return;
    }
    if let Some(apps) = read_start_apps() {
        let mut cache = CACHE.lock().unwrap();
        cache.apps = apps;
        cache.loaded_at = Some(Instant::now());
    }
}

/// Refresh the list in the background (e.g. when the pane opens), so newly
/// installed apps show up without slowing anything down.
pub fn refresh_in_background() {
    std::thread::spawn(|| reload(false));
}

fn cached() -> Vec<App> {
    CACHE.lock().unwrap().apps.clone()
}

/// Whether `id` is an app in the list.
pub fn exists(id: &str) -> bool {
    CACHE.lock().unwrap().apps.iter().any(|a| a.id == id)
}

/// The Start menu name of the app with this id, if it's in the list.
pub fn name_of(id: &str) -> Option<String> {
    CACHE.lock().unwrap().apps.iter().find(|a| a.id.eq_ignore_ascii_case(id)).map(|a| a.name.clone())
}

/// The app list, reading it first if that hasn't happened yet.
pub async fn all() -> Vec<App> {
    let apps = cached();
    if !apps.is_empty() {
        return apps;
    }
    let _ = tauri::async_runtime::spawn_blocking(|| reload(true)).await;
    cached()
}

#[tauri::command]
pub async fn list_apps() -> Vec<App> {
    all().await
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn init_com() {
    unsafe {
        // Harmless if this thread already initialised COM.
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
    }
}

/// Close the pane and launch an app from the list.
///
/// The pane closes first and the launch runs in the background, so the pane
/// doesn't hang around while Windows starts the app (which can take a while).
#[tauri::command]
pub fn launch_app(app: AppHandle, id: String) -> Result<(), String> {
    // Only launch things that are actually in the app list.
    if !exists(&id) {
        return Err("Unknown app".into());
    }
    library::record_launch(&id);
    library::changed(&app);
    shell_open_from_pane(&app, &format!("shell:AppsFolder\\{id}"));
    Ok(())
}

/// Close the pane and open `target` (an app, file, folder or URI such as
/// "ms-settings:") the way Explorer would.
pub fn shell_open_from_pane(app: &AppHandle, target: &str) {
    // Must happen while the pane is still in front: it lets the new app take
    // the foreground even though the pane is gone by the time it appears.
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
    }
    // Don't hand focus back to the previous window; the new app should get it.
    pane::close_for_launch(app);

    // In the background, as Windows can take a while to start things.
    let target = target.to_string();
    std::thread::spawn(move || unsafe {
        init_com();
        let file = wide(&target);
        let verb = wide("open");
        let result = ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        if result as isize <= 32 {
            eprintln!("The Pane: could not open {target} (error {})", result as isize);
        }
    });
}

/// An app's icon as raw RGBA pixels (square; side = sqrt(len / 4)).
/// 48px normally; with `large`, 256px when the app has an icon that big.
/// Empty if the icon can't be read.
#[tauri::command]
pub async fn app_icon(id: String, large: Option<bool>) -> Response {
    let pixels = tauri::async_runtime::spawn_blocking(move || {
        init_com();
        let path = format!("shell:AppsFolder\\{id}");
        let big = if large.unwrap_or(false) { icon_pixels(&path, SHIL_JUMBO) } else { None };
        big.or_else(|| icon_pixels(&path, SHIL_EXTRALARGE)).unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    Response::new(pixels)
}

/// IID_IImageList
const IID_IMAGE_LIST: GUID = GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);

/// `list` is SHIL_EXTRALARGE (48px) or SHIL_JUMBO (256px).
fn icon_pixels(path: &str, list: u32) -> Option<Vec<u8>> {
    let pixels = unsafe {
        let name = wide(path);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        if SHParseDisplayName(name.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut()) < 0
            || pidl.is_null()
        {
            return None;
        }
        let icon = sized_icon(pidl, list, list == SHIL_EXTRALARGE);
        CoTaskMemFree(pidl as *const _);
        let icon = icon?;
        let pixels = hicon_to_rgba(icon);
        DestroyIcon(icon);
        pixels?
    };
    // Apps without a real 256px icon come back as their small icon drawn in
    // the top-left corner of a 256px canvas. Treat that as "no large icon".
    if list == SHIL_JUMBO && only_top_left(&pixels, 48) {
        return None;
    }
    Some(pixels)
}

/// Whether every pixel outside the top-left `n`×`n` square is transparent.
fn only_top_left(rgba: &[u8], n: usize) -> bool {
    let side = ((rgba.len() / 4) as f64).sqrt() as usize;
    rgba.chunks_exact(4)
        .enumerate()
        .all(|(i, p)| (i % side < n && i / side < n) || p[3] == 0)
}

/// The item's icon from the given system image list; optionally falling back
/// to its plain 32px icon.
unsafe fn sized_icon(pidl: *mut ITEMIDLIST, list_size: u32, fallback: bool) -> Option<HICON> {
    let mut info: SHFILEINFOW = std::mem::zeroed();
    let size = std::mem::size_of::<SHFILEINFOW>() as u32;
    let path = pidl as *const u16;

    if SHGetFileInfoW(path, 0, &mut info, size, SHGFI_PIDL | SHGFI_SYSICONINDEX) != 0 {
        let mut list: *mut std::ffi::c_void = std::ptr::null_mut();
        if SHGetImageList(list_size as i32, &IID_IMAGE_LIST, &mut list) >= 0 && !list.is_null() {
            // IImageList vtable: IUnknown (0-2), then Add, ReplaceIcon,
            // SetOverlayImage, Replace, AddMasked, Draw, Remove, GetIcon (10).
            let vtable = *(list as *const *const usize);
            type GetIcon = unsafe extern "system" fn(*mut std::ffi::c_void, i32, u32, *mut HICON) -> i32;
            type Release = unsafe extern "system" fn(*mut std::ffi::c_void) -> u32;
            let get_icon: GetIcon = std::mem::transmute(*vtable.add(10));
            let release: Release = std::mem::transmute(*vtable.add(2));
            const ILD_TRANSPARENT: u32 = 1;
            let mut icon: HICON = std::ptr::null_mut();
            let hr = get_icon(list, info.iIcon, ILD_TRANSPARENT, &mut icon);
            release(list);
            if hr >= 0 && !icon.is_null() {
                return Some(icon);
            }
        }
    }

    if !fallback {
        return None;
    }
    let mut info: SHFILEINFOW = std::mem::zeroed();
    if SHGetFileInfoW(path, 0, &mut info, size, SHGFI_PIDL | SHGFI_ICON | SHGFI_LARGEICON) != 0
        && !info.hIcon.is_null()
    {
        return Some(info.hIcon);
    }
    None
}

/// Read a bitmap as top-down 32-bit BGRA rows.
pub(crate) unsafe fn bitmap_bgra(bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // negative = top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let dc = CreateCompatibleDC(std::ptr::null_mut());
    let lines = GetDIBits(dc, bitmap, 0, h as u32, buf.as_mut_ptr() as *mut _, &mut bmi, DIB_RGB_COLORS);
    DeleteDC(dc);
    (lines == h).then_some(buf)
}

pub(crate) unsafe fn hicon_to_rgba(icon: HICON) -> Option<Vec<u8>> {
    let mut info: ICONINFO = std::mem::zeroed();
    if GetIconInfo(icon, &mut info) == 0 {
        return None;
    }
    let result = (|| {
        if info.hbmColor.is_null() {
            return None; // monochrome icon; not worth supporting
        }
        let mut bm: BITMAP = std::mem::zeroed();
        if GetObjectW(info.hbmColor, std::mem::size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut _) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || w != h {
            return None;
        }
        let mut px = bitmap_bgra(info.hbmColor, w, h)?;
        // Old-style icons have no alpha channel; use the mask instead.
        if px.chunks_exact(4).all(|p| p[3] == 0) {
            let mask = bitmap_bgra(info.hbmMask, w, h)?;
            for (p, m) in px.chunks_exact_mut(4).zip(mask.chunks_exact(4)) {
                p[3] = if m[0] == 0 { 255 } else { 0 };
            }
        }
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2); // BGRA -> RGBA
        }
        Some(px)
    })();
    if !info.hbmColor.is_null() {
        DeleteObject(info.hbmColor as _);
    }
    if !info.hbmMask.is_null() {
        DeleteObject(info.hbmMask as _);
    }
    result
}
