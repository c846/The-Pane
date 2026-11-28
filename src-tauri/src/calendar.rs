//! The user's own calendar events, saved in %LOCALAPPDATA%\The Pane\events.json.
//! (Holidays are worked out by the page; only personal events are stored.)

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    id: String,
    /// "YYYY-MM-DD"
    date: String,
    title: String,
    /// Repeats on the same day every year (birthdays, anniversaries).
    #[serde(default)]
    yearly: bool,
}

/// Serialises reads and writes of the file.
static LOCK: Mutex<()> = Mutex::new(());

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("events.json"))
}

fn load() -> Vec<Event> {
    file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(events: &[Event]) -> Result<(), String> {
    let path = file().ok_or("No settings folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(events).map_err(|e| e.to_string())?;
    // Write a temporary file and swap it in, so a crash can't leave half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

#[tauri::command]
pub fn get_events() -> Vec<Event> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load()
}

#[tauri::command]
pub fn add_event(app: AppHandle, date: String, title: String, yearly: bool) -> Result<Event, String> {
    let title = title.trim();
    if !valid_date(&date) {
        return Err("Invalid date".into());
    }
    if title.is_empty() || title.chars().count() > 100 {
        return Err("The event needs a name of up to 100 characters".into());
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut events = load();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let event = Event { id: format!("{nanos:x}"), date, title: title.to_string(), yearly };
    events.push(event.clone());
    save(&events)?;
    let _ = app.emit("events-changed", ());
    Ok(event)
}

#[tauri::command]
pub fn remove_event(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut events = load();
    events.retain(|e| e.id != id);
    save(&events)?;
    let _ = app.emit("events-changed", ());
    Ok(())
}
