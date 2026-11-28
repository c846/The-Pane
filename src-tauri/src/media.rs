//! Music: what's playing and its controls, for the Music widgets.
//!
//! Uses Windows' own media sessions (the same thing behind the media controls
//! in Quick Settings), so it works with Spotify, browsers, Media Player and
//! any other app that reports what it's playing. Each app with media is one
//! "session"; the pane can switch between them.
//!
//! All calls run on the COM worker thread from system.rs.

use serde::Serialize;
use tauri::ipc::Response;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

use crate::{apps, system::on_com_thread};

thread_local! {
    static MANAGER: std::cell::OnceCell<Option<Manager>> = const { std::cell::OnceCell::new() };
}

fn manager() -> Option<Manager> {
    MANAGER.with(|m| {
        m.get_or_init(|| Manager::RequestAsync().ok()?.join().ok())
            .clone()
    })
}

/// Sessions with ids that stay the same between calls: the app's id, plus
/// "#2", "#3"… if one app has several (e.g. two browser tabs).
fn sessions() -> Vec<(String, Session)> {
    let Some(m) = manager() else { return Vec::new() };
    let Ok(list) = m.GetSessions() else { return Vec::new() };
    let mut seen: Vec<String> = Vec::new();
    list.into_iter()
        .filter_map(|s| {
            let app = s.SourceAppUserModelId().ok()?.to_string();
            let n = seen.iter().filter(|x| **x == app).count();
            seen.push(app.clone());
            let id = if n == 0 { app } else { format!("{app}#{}", n + 1) };
            Some((id, s))
        })
        .collect()
}

fn find(id: &str) -> Option<Session> {
    sessions().into_iter().find(|(sid, _)| sid == id).map(|(_, s)| s)
}

/// A readable app name for a media app id, e.g. "Spotify.exe" -> "Spotify".
fn app_name(app_id: &str) -> String {
    if let Some(name) = apps::name_of(app_id) {
        return name;
    }
    let tail = app_id.rsplit('\\').next().unwrap_or(app_id);
    let tail = tail.strip_suffix(".exe").unwrap_or(tail);
    // Store apps: "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" -> "ZuneMusic"
    let tail = tail.split(['_', '!']).next().unwrap_or(tail);
    tail.rsplit('.').next().unwrap_or(tail).to_string()
}

const TICKS_PER_MS: i64 = 10_000;
/// 100ns ticks between 1601-01-01 (Windows) and 1970-01-01 (Unix).
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    id: String,
    /// The app's id, for its icon.
    app_id: String,
    app: String,
    /// The one Windows considers current (what the media keys control).
    is_current: bool,
    status: &'static str,
    title: String,
    artist: String,
    album: String,
    album_artist: String,
    subtitle: String,
    track_number: i32,
    track_count: i32,
    genres: Vec<String>,
    /// Position and length in ms; `updated_at` is when the app last reported
    /// the position (Unix ms), so the page can keep counting while playing.
    position: i64,
    duration: i64,
    updated_at: i64,
    can_play: bool,
    can_pause: bool,
    can_next: bool,
    can_previous: bool,
    can_seek: bool,
    has_art: bool,
}

fn describe(id: String, s: &Session, current: Option<&str>) -> Option<MediaSession> {
    let app_id = s.SourceAppUserModelId().ok()?.to_string();
    let info = s.GetPlaybackInfo().ok()?;
    let controls = info.Controls().ok()?;
    let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok();
    let timeline = s.GetTimelineProperties().ok();

    let text = |f: Option<windows::core::Result<windows::core::HSTRING>>| {
        f.and_then(|r| r.ok()).map(|h| h.to_string()).unwrap_or_default()
    };
    let p = props.as_ref();
    let status = match info.PlaybackStatus().unwrap_or(Status::Closed) {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Stopped => "stopped",
        Status::Changing => "changing",
        _ => "closed",
    };
    let (position, duration, updated_at) = timeline
        .and_then(|t| {
            let start = t.StartTime().ok()?.Duration;
            let end = t.EndTime().ok()?.Duration;
            let pos = t.Position().ok()?.Duration;
            let updated = t.LastUpdatedTime().ok()?.UniversalTime;
            Some((
                (pos - start).max(0) / TICKS_PER_MS,
                (end - start).max(0) / TICKS_PER_MS,
                (updated - UNIX_EPOCH_TICKS) / TICKS_PER_MS,
            ))
        })
        .unwrap_or((0, 0, 0));

    Some(MediaSession {
        is_current: current == Some(app_id.as_str()),
        app: app_name(&app_id),
        app_id,
        id,
        status,
        title: text(p.map(|p| p.Title())),
        artist: text(p.map(|p| p.Artist())),
        album: text(p.map(|p| p.AlbumTitle())),
        album_artist: text(p.map(|p| p.AlbumArtist())),
        subtitle: text(p.map(|p| p.Subtitle())),
        track_number: p.and_then(|p| p.TrackNumber().ok()).unwrap_or(0),
        track_count: p.and_then(|p| p.AlbumTrackCount().ok()).unwrap_or(0),
        genres: p
            .and_then(|p| p.Genres().ok())
            .map(|g| g.into_iter().map(|h| h.to_string()).collect())
            .unwrap_or_default(),
        position,
        duration,
        updated_at,
        can_play: controls.IsPlayEnabled().unwrap_or(false),
        can_pause: controls.IsPauseEnabled().unwrap_or(false),
        can_next: controls.IsNextEnabled().unwrap_or(false),
        can_previous: controls.IsPreviousEnabled().unwrap_or(false),
        can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false) && duration > 0,
        has_art: p.and_then(|p| p.Thumbnail().ok()).is_some(),
    })
}

/// Everything that's playing (or paused) right now.
#[tauri::command]
pub async fn media_sessions() -> Vec<MediaSession> {
    on_com_thread(|| {
        let current = manager()
            .and_then(|m| m.GetCurrentSession().ok())
            .and_then(|s| s.SourceAppUserModelId().ok())
            .map(|h| h.to_string());
        sessions()
            .into_iter()
            .filter_map(|(id, s)| describe(id, &s, current.as_deref()))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// The album art (an image file's bytes; empty if there is none).
#[tauri::command]
pub async fn media_art(id: String) -> Response {
    let bytes = on_com_thread(move || {
        let read = || -> windows::core::Result<Vec<u8>> {
            let Some(s) = find(&id) else { return Ok(Vec::new()) };
            let thumb = s.TryGetMediaPropertiesAsync()?.join()?.Thumbnail()?;
            let stream = thumb.OpenReadAsync()?.join()?;
            let size = stream.Size()? as u32;
            let reader = DataReader::CreateDataReader(&stream)?;
            let loaded = reader.LoadAsync(size)?.join()?;
            let mut buf = vec![0u8; loaded as usize];
            reader.ReadBytes(&mut buf)?;
            Ok(buf)
        };
        read().unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    Response::new(bytes)
}

/// play, pause, toggle, next or previous.
#[tauri::command]
pub async fn media_control(id: String, action: String) -> Result<(), String> {
    on_com_thread(move || {
        let s = find(&id).ok_or("That player has closed")?;
        let op = match action.as_str() {
            "play" => s.TryPlayAsync(),
            "pause" => s.TryPauseAsync(),
            "toggle" => s.TryTogglePlayPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "previous" => s.TrySkipPreviousAsync(),
            _ => return Err(format!("Unknown action: {action}")),
        };
        op.and_then(|o| o.join()).map(|_| ()).map_err(|e| e.message())
    })
    .await
    .unwrap_or(Err("Media controls unavailable".into()))
}

/// Jump to a position (ms from the start of the track).
#[tauri::command]
pub async fn media_seek(id: String, position: i64) -> Result<(), String> {
    on_com_thread(move || {
        let s = find(&id).ok_or("That player has closed")?;
        let start = s
            .GetTimelineProperties()
            .and_then(|t| t.StartTime())
            .map(|t| t.Duration)
            .unwrap_or(0);
        s.TryChangePlaybackPositionAsync(start + position.max(0) * TICKS_PER_MS)
            .and_then(|o| o.join())
            .map(|_| ())
            .map_err(|e| e.message())
    })
    .await
    .unwrap_or(Err("Media controls unavailable".into()))
}
