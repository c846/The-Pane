//! The widgets placed in the pane and on the desktop: which, where, at what
//! size, and whether each surface's layout is locked. Saved in
//! %LOCALAPPDATA%\The Pane\widgets.json.
//!
//! Every widget can go on either surface ("pane" or "desktop"); the same
//! code runs it in both (see src/shared/widget-host.js). The pane's settings
//! add widgets (`add_widget`) and lock a surface (`lock_widgets`); each
//! surface places, moves, resizes and removes its own (`place_widget`,
//! `remove_widget`). Each change is made here, one at a time, and then every
//! window is told ("widgets-changed"), so no window can overwrite another's
//! change with an old copy.
//!
//! Positions and sizes are in grid cells. A widget that was just added has
//! no position yet; its surface finds it a free spot and saves it.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PANE: &str = "pane";
pub const DESKTOP: &str = "desktop";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Layout {
    /// The desktop's widgets can't be moved, resized or removed.
    pub locked: bool,
    /// The same, for the pane's widgets.
    pub pane_locked: bool,
    /// The pane has been given its starting widgets (once; layouts saved
    /// before the pane had widgets get them on first load). Missing from
    /// those older files, so false there, whatever `Default` says.
    #[serde(default)]
    pub pane_seeded: bool,
    pub widgets: Vec<Placed>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Placed {
    /// Unique among all placed widgets.
    pub id: String,
    /// Which widget it is (its folder in src/widgets), e.g. "weather".
    pub kind: String,
    /// "pane" or "desktop".
    #[serde(default = "desktop")]
    pub surface: String,
    /// Top-left cell, or None until its surface places it.
    pub col: Option<i32>,
    pub row: Option<i32>,
    /// Size in cells.
    pub w: u32,
    pub h: u32,
}

fn desktop() -> String {
    DESKTOP.into()
}

/// A fresh install: no widgets anywhere; the user adds their own.
impl Default for Layout {
    fn default() -> Self {
        Self { locked: false, pane_locked: false, pane_seeded: true, widgets: Vec::new() }
    }
}

/// For layouts saved before the pane had widgets (updating from an older
/// version): the pane's widgets, arranged like the pane was before: apps and PC controls down the left, weather and music in the
/// middle, the calendar and the date on the right. It fits a 11x5 grid
/// (a 1366x768 screen); on a smaller one, the pane moves what doesn't fit.
/// Battery and brightness are only added on PCs with a battery (laptops,
/// whose screens can be dimmed); a desktop PC has nothing for them to show.
fn seed_pane(layout: &mut Layout) {
    let laptop = crate::system::get_battery().is_some();
    let mut add = |kind: &str, col: i32, row: i32, w: u32, h: u32| {
        let id = next_id(layout, kind);
        layout.widgets.push(Placed { id, kind: kind.into(), surface: PANE.into(), col: Some(col), row: Some(row), w, h });
    };
    add("recent", 0, 0, 3, 1);
    add("favorites", 0, 1, 3, 1);
    add("volume", 0, 2, 3, 1);
    if laptop {
        add("brightness", 0, 3, 3, 1);
        add("battery", 0, 4, 3, 1);
    }
    add("weather", 3, 0, 5, 3);
    add("music", 3, 3, 5, 2);
    add("calendar", 8, 0, 3, 3);
    add("date", 8, 3, 3, 2);
    layout.pane_seeded = true;
}

fn next_id(layout: &Layout, kind: &str) -> String {
    (1..)
        .map(|n| format!("{kind}-{n}"))
        .find(|id| !layout.widgets.iter().any(|p| &p.id == id))
        .unwrap()
}

static LAYOUT: Mutex<Option<Layout>> = Mutex::new(None);

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("widgets.json"))
}

fn load() -> Layout {
    let mut layout: Layout = file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if !layout.pane_seeded {
        seed_pane(&mut layout);
        let _ = save(&layout);
    }
    layout
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

fn check_surface(surface: &str) -> Result<(), String> {
    if surface == PANE || surface == DESKTOP {
        Ok(())
    } else {
        Err(format!("No surface called \"{surface}\""))
    }
}

#[tauri::command]
pub fn get_widgets() -> Layout {
    let mut guard = LAYOUT.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(load).clone()
}

/// Add a widget to a surface at its default size; the surface places it.
/// Returns its id.
#[tauri::command]
pub fn add_widget(app: AppHandle, surface: String, kind: String, w: u32, h: u32) -> Result<String, String> {
    check_surface(&surface)?;
    if kind.is_empty() || w == 0 || h == 0 {
        return Err("Not a widget".into());
    }
    update(&app, |l| {
        let id = next_id(l, &kind);
        l.widgets.push(Placed { id: id.clone(), kind, surface, col: None, row: None, w, h });
        id
    })
}

/// Move and/or resize a widget (from its surface).
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
    update(&app, |l| l.widgets.retain(|p| p.id != id))?;
    crate::notes::forget(&id);
    Ok(())
}

#[tauri::command]
pub fn lock_widgets(app: AppHandle, surface: String, locked: bool) -> Result<(), String> {
    check_surface(&surface)?;
    update(&app, |l| {
        if surface == PANE {
            l.pane_locked = locked;
        } else {
            l.locked = locked;
        }
    })
}
