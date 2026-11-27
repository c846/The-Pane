//! The desktop's widgets: which are placed, where, at what size, and whether
//! the layout is locked. Saved in %LOCALAPPDATA%\The Pane\widgets.json.
//!
//! The pane's settings add widgets (`add_widget`) and lock the layout
//! (`lock_widgets`); the desktop window places, moves, resizes and removes
//! them (`place_widget`, `remove_widget`). Each change is made here, one at
//! a time, and then every window is told ("widgets-changed"), so neither
//! window can overwrite the other's change with an old copy.
//!
//! Positions and sizes are in grid cells (see src/widgets/desktop.js). A
//! widget that was just added has no position yet; the desktop finds it a
//! free spot and saves it.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Layout {
    /// Widgets can't be moved, resized or removed.
    pub locked: bool,
    pub widgets: Vec<Placed>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Placed {
    /// Unique among the placed widgets.
    pub id: String,
    /// Which widget it is (its folder in src/widgets), e.g. "weather".
    pub kind: String,
    /// Top-left cell, or None until the desktop places it.
    pub col: Option<i32>,
    pub row: Option<i32>,
    /// Size in cells.
    pub w: u32,
    pub h: u32,
}

/// First run: the weather widget, wherever it fits.
impl Default for Layout {
    fn default() -> Self {
        Self {
            locked: false,
            widgets: vec![Placed { id: "weather-1".into(), kind: "weather".into(), col: None, row: None, w: 3, h: 2 }],
        }
    }
}

static LAYOUT: Mutex<Option<Layout>> = Mutex::new(None);

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("widgets.json"))
}

fn load() -> Layout {
    file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(layout: &Layout) -> Result<(), String> {
    let path = file().ok_or("No settings folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(layout).map_err(|e| e.to_string())?;
    // Write a temporary file and swap it in, so a crash can't leave half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Run `f` on the layout, then save it and tell every window.
fn update<R>(app: &AppHandle, f: impl FnOnce(&mut Layout) -> R) -> Result<R, String> {
    let mut guard = LAYOUT.lock().unwrap_or_else(|e| e.into_inner());
    let layout = guard.get_or_insert_with(load);
    let result = f(layout);
    save(layout)?;
    let _ = app.emit("widgets-changed", &*layout);
    Ok(result)
}

#[tauri::command]
pub fn get_widgets() -> Layout {
    let mut guard = LAYOUT.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(load).clone()
}

/// Add a widget at its default size; the desktop places it. Returns its id.
#[tauri::command]
pub fn add_widget(app: AppHandle, kind: String, w: u32, h: u32) -> Result<String, String> {
    if kind.is_empty() || w == 0 || h == 0 {
        return Err("Not a widget".into());
    }
    update(&app, |l| {
        let id = (1..)
            .map(|n| format!("{kind}-{n}"))
            .find(|id| !l.widgets.iter().any(|p| &p.id == id))
            .unwrap();
        l.widgets.push(Placed { id: id.clone(), kind, col: None, row: None, w, h });
        id
    })
}

/// Move and/or resize a widget (from the desktop).
#[tauri::command]
pub fn place_widget(app: AppHandle, id: String, col: i32, row: i32, w: u32, h: u32) -> Result<(), String> {
    update(&app, |l| {
        if let Some(p) = l.widgets.iter_mut().find(|p| p.id == id) {
            *p = Placed { col: Some(col), row: Some(row), w, h, ..p.clone() };
        }
    })
}

#[tauri::command]
pub fn remove_widget(app: AppHandle, id: String) -> Result<(), String> {
    update(&app, |l| l.widgets.retain(|p| p.id != id))
}

#[tauri::command]
pub fn lock_widgets(app: AppHandle, locked: bool) -> Result<(), String> {
    update(&app, |l| l.locked = locked)
}
