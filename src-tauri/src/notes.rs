//! What's typed in each Notes widget, saved in
//! %LOCALAPPDATA%\The Pane\notes.json by widget id. A note is forgotten when
//! its widget is removed (widgets.rs).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// One change to the file at a time.
static LOCK: Mutex<()> = Mutex::new(());

type Notes = BTreeMap<String, String>;

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("notes.json"))
}

fn load() -> Notes {
    file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(notes: &Notes) -> Result<(), String> {
    let path = file().ok_or("No settings folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(notes).map_err(|e| e.to_string())?;
    // Write a temporary file and swap it in, so a crash can't leave half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_note(id: String) -> String {
    let _guard = LOCK.lock();
    load().remove(&id).unwrap_or_default()
}

#[tauri::command]
pub fn save_note(id: String, text: String) -> Result<(), String> {
    let _guard = LOCK.lock();
    let mut notes = load();
    if text.is_empty() {
        notes.remove(&id);
    } else {
        notes.insert(id, text);
    }
    save(&notes)
}

/// The widget `id` was removed: drop its note.
pub fn forget(id: &str) {
    let _guard = LOCK.lock();
    let mut notes = load();
    if notes.remove(id).is_some() {
        let _ = save(&notes);
    }
}
