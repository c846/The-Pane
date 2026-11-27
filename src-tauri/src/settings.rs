//! The Pane's own settings, saved in %LOCALAPPDATA%\The Pane\settings.json.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// US ZIP code for the weather ("" = not set).
    pub zip: String,
    pub panels: Panels,
    pub widgets: Widgets,
}

/// Which panels are shown.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Panels {
    pub apps: bool,
    pub weather: bool,
    pub calendar: bool,
    pub music: bool,
}

impl Default for Panels {
    fn default() -> Self {
        Self { apps: true, weather: true, calendar: true, music: true }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self { zip: String::new(), panels: Panels::default(), widgets: Widgets::default() }
    }
}

/// Which desktop widgets are shown (see src/widgets).
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Widgets {
    pub weather: bool,
}

impl Default for Widgets {
    fn default() -> Self {
        Self { weather: true }
    }
}

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("The Pane").join("settings.json"))
}

pub fn load() -> Settings {
    file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings() -> Settings {
    load()
}

/// Saves the settings and tells every window (the pane and the desktop).
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let zip = settings.zip.trim();
    if !zip.is_empty() && !(zip.len() == 5 && zip.bytes().all(|b| b.is_ascii_digit())) {
        return Err("ZIP code must be 5 digits".into());
    }
    let settings = Settings { zip: zip.to_string(), ..settings };

    let path = file().ok_or("No settings folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Write a temporary file and swap it in, so a crash can't leave half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let _ = app.emit("settings-changed", &settings);
    Ok(())
}
