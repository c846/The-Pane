//! The user's recently launched and favorite apps, saved between runs in
//! %LOCALAPPDATA%\The Pane\apps.json.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::apps::{self, App};

/// How many recent launches to remember (the pane shows fewer).
const MAX_RECENT: usize = 12;

#[derive(Default, Serialize, Deserialize)]
struct Lists {
    #[serde(default)]
    recent: Vec<String>,
    #[serde(default)]
    favorites: Vec<String>,
}

static LISTS: Mutex<Option<Lists>> = Mutex::new(None);

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("apps.json"))
}

fn load() -> Lists {
    file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(lists: &Lists) {
    let Some(path) = file() else { return };
    let Ok(json) = serde_json::to_string_pretty(lists) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write a temporary file and swap it in, so a crash can't leave half a file.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Tell every window (the pane's and the desktop's app widgets) that the
/// lists changed.
pub fn changed(app: &AppHandle) {
    let _ = app.emit("apps-changed", ());
}

/// Run `f` on the lists, saving afterwards.
fn update<R>(f: impl FnOnce(&mut Lists) -> R) -> R {
    let mut guard = LISTS.lock().unwrap_or_else(|e| e.into_inner());
    let lists = guard.get_or_insert_with(load);
    let result = f(lists);
    save(lists);
    result
}

pub fn record_launch(id: &str) {
    update(|l| {
        l.recent.retain(|r| r != id);
        l.recent.insert(0, id.to_string());
        l.recent.truncate(MAX_RECENT);
    });
}

#[derive(Serialize)]
pub struct AppLists {
    recent: Vec<App>,
    favorites: Vec<App>,
}

/// Recent apps (newest first) and favorites (in the user's order). Apps that
/// are no longer installed are left out, but stay remembered in case they
/// come back (e.g. the app list was read mid-update).
#[tauri::command]
pub async fn app_lists() -> AppLists {
    let all = apps::all().await;
    let resolve = |ids: &[String]| -> Vec<App> {
        ids.iter()
            .filter_map(|id| all.iter().find(|a| &a.id == id).cloned())
            .collect()
    };
    let mut guard = LISTS.lock().unwrap_or_else(|e| e.into_inner());
    let lists = guard.get_or_insert_with(load);
    AppLists {
        recent: resolve(&lists.recent),
        favorites: resolve(&lists.favorites),
    }
}

#[tauri::command]
pub fn set_favorite(app: AppHandle, id: String, favorite: bool) -> Result<(), String> {
    if favorite && !apps::exists(&id) {
        return Err("Unknown app".into());
    }
    update(|l| {
        let present = l.favorites.contains(&id);
        if favorite && !present {
            l.favorites.push(id);
        } else if !favorite {
            l.favorites.retain(|f| f != &id);
        }
    });
    changed(&app);
    Ok(())
}

/// Move a favorite to a new position (0 = first).
#[tauri::command]
pub fn move_favorite(app: AppHandle, id: String, index: usize) {
    update(|l| {
        if let Some(from) = l.favorites.iter().position(|f| f == &id) {
            let item = l.favorites.remove(from);
            let to = index.min(l.favorites.len());
            l.favorites.insert(to, item);
        }
    });
    changed(&app);
}

#[tauri::command]
pub fn forget_recent(app: AppHandle, id: String) {
    update(|l| l.recent.retain(|r| r != &id));
    changed(&app);
}
