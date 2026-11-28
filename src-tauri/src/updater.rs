//! Updating in place from GitHub.
//!
//! Every push to `main` builds a signed installer and publishes it as the
//! latest GitHub release (see .github/workflows/release.yml). Once per start
//! (so in practice once per sign-in) The Pane asks GitHub whether that
//! release is newer than itself. If it is, the desktop shows a card offering
//! to update (desktop.js); there's no way to check by hand.
//!
//! Updating downloads the installer, checks its signature against the public
//! key in tauri.conf.json, quits, and runs it in passive mode (a small
//! progress window, no questions). The installer starts The Pane again when
//! it's done, so Explorer isn't brought back in between.
//!
//! The network may not be up yet right after sign-in, so a failed check is
//! retried for a while before giving up until the next start.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{debug_log, frame};

/// How many times to try reaching GitHub, and how long to wait in between.
const ATTEMPTS: u32 = 20;
const RETRY_AFTER: Duration = Duration::from_secs(30);

/// The update found at startup, until it's installed.
static PENDING: Mutex<Option<Update>> = Mutex::new(None);

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

impl From<&Update> for UpdateInfo {
    fn from(u: &Update) -> Self {
        Self {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone().map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        }
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Call once at startup: checks for an update in the background and tells
/// the pages ("update-available") if there is one.
pub fn check_in_background(app: AppHandle) {
    // Debug builds are always "older" than the latest release; only check
    // when asked to.
    #[cfg(debug_assertions)]
    if std::env::var("PANE_DEBUG_UPDATE").is_err() {
        return;
    }
    std::thread::spawn(move || {
        for attempt in 1..=ATTEMPTS {
            match tauri::async_runtime::block_on(check(&app)) {
                Ok(Some(update)) => {
                    debug_log::log(format!("update: {} is available", update.version));
                    let info = UpdateInfo::from(&update);
                    *PENDING.lock().unwrap() = Some(update);
                    let _ = app.emit("update-available", info);
                    return;
                }
                Ok(None) => {
                    debug_log::log("update: up to date");
                    return;
                }
                Err(e) => {
                    debug_log::log(format!("update: check {attempt} failed: {e}"));
                    std::thread::sleep(RETRY_AFTER);
                }
            }
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater_builder()
        // Put other apps' window corners back, as quitting normally does.
        .on_before_exit(frame::restore)
        .build()?
        .check()
        .await
}

/// The update found at startup, if any (for a page that loaded after the
/// "update-available" event went out).
#[tauri::command]
pub fn pending_update() -> Option<UpdateInfo> {
    PENDING.lock().unwrap().as_ref().map(UpdateInfo::from)
}

/// Download and install the pending update. Reports progress as
/// "update-progress". On success The Pane quits and the installer takes
/// over, so this only ever returns an error.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = PENDING.lock().unwrap().clone().ok_or("There's no update to install")?;
    let mut downloaded = 0u64;
    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await;
    result.map_err(|e| {
        debug_log::log(format!("update: install failed: {e}"));
        e.to_string()
    })
}
