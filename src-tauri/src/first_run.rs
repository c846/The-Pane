//! The first run after a fresh install: no wallpaper (the desktop and the
//! pane show solid white instead; see desktop.js and backdrop.js), no
//! widgets anywhere (see widgets.rs), and a welcome card in the middle of
//! the desktop until it's closed.
//!
//! A fresh install is one with none of The Pane's saved files yet. (They're
//! kept across updates, so updating never counts as fresh.) The welcome is
//! owed until the card's Close button is clicked: a marker file says so, so
//! it's shown again if The Pane is restarted before then, and never after.

use std::path::PathBuf;

use crate::desktop;

fn data_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane"))
}

fn welcome_marker() -> Option<PathBuf> {
    Some(data_dir()?.join("welcome-pending"))
}

/// Call once at startup, before anything is loaded or saved.
pub fn check() {
    let Some(dir) = data_dir() else {
        return;
    };
    let saved = ["settings.json", "widgets.json", "apps.json", "events.json"];
    if saved.iter().any(|f| dir.join(f).exists()) {
        return;
    }
    crate::debug_log::log("first run: clearing the wallpaper, owing a welcome");
    desktop::clear_wallpaper();
    let _ = std::fs::create_dir_all(&dir);
    if let Some(marker) = welcome_marker() {
        let _ = std::fs::write(marker, b"");
    }
}

/// The name to welcome the user by, if the welcome hasn't been closed yet.
#[tauri::command]
pub fn welcome() -> Option<String> {
    welcome_marker().filter(|m| m.exists())?;
    Some(user_name())
}

/// The welcome card was closed: never show it again.
#[tauri::command]
pub fn welcome_done() {
    if let Some(marker) = welcome_marker() {
        let _ = std::fs::remove_file(marker);
    }
}

/// The user's name as Windows shows it (e.g. "Jane Doe"), else their
/// sign-in name.
fn user_name() -> String {
    use windows_sys::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    let display = unsafe { GetUserNameExW(NameDisplay, buf.as_mut_ptr(), &mut len) };
    if display && len > 0 {
        let name = String::from_utf16_lossy(&buf[..len as usize]).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("USERNAME").unwrap_or_default()
}
