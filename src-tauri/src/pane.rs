//! Opening, closing and placing the pane window.
//!
//! The pane window covers the whole screen and is transparent; the page
//! slides the pane itself in and out inside it (see slide.js). This module
//! decides when, and shows, hides and focuses the window around those slides.
//!
//! The window is in one of four modes:
//! - HIDDEN:  not shown.
//! - PEEK:    the cursor is near the left edge. Shown, but unfocused and
//!            click-through; the page shows just the edge of the pane, slid
//!            further out the harder the mouse pushes into the edge.
//! - OPEN:    shown, focused and interactive. Pushing into the right edge
//!            slides it back a little (and enough pushing closes it).
//! - GLANCE:  partly open to show something brief without the full pane:
//!            the volume popup or the Alt+Space window switcher. Unfocused
//!            and click-through, like PEEK.
//! - CLOSING: sliding away (after closing, or when a peek or glance retracts).
//!            Click-through; hidden once the slide is over, unless it is
//!            opened or peeked again first.
//!
//! Opening works in two steps, so the pane never slides in with an old
//! wallpaper:
//! 1. Tell the page ("pane-opening"); if the wallpaper changed, it reloads it.
//! 2. The page calls `reveal_pane`, which focuses the window, then slides the
//!    pane in. (If the page doesn't answer quickly, it's focused anyway.)

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::thread;
use std::time::Duration;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager};

use crate::{apps, win};

/// Focus the pane after this long even if the page hasn't answered yet.
const REVEAL_FALLBACK: Duration = Duration::from_millis(400);
/// Hide the window this long after it starts sliding away. Must be longer
/// than the page's close slide and peek retraction (slide.js).
const HIDE_AFTER: Duration = Duration::from_millis(360);

const HIDDEN: u8 = 0;
const PEEK: u8 = 1;
const OPEN: u8 = 2;
const CLOSING: u8 = 3;
const GLANCE: u8 = 4;

/// What a GLANCE shows.
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Glance {
    Volume = 1,
    Switcher = 2,
}

static MODE: AtomicU8 = AtomicU8::new(HIDDEN);
static GLANCE_KIND: AtomicU8 = AtomicU8::new(0);
/// Bumped on every mode change, so a delayed hide can tell whether it is
/// still wanted.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static REVEALED: AtomicBool = AtomicBool::new(false);
static PANE_HWND: AtomicIsize = AtomicIsize::new(0);
/// Window that was in front before the pane opened.
static PREVIOUS: AtomicIsize = AtomicIsize::new(0);
/// Last slide amount sent to the page (f32 bits), to skip repeats.
static LAST_SENT: AtomicU32 = AtomicU32::new(u32::MAX);

pub fn is_open() -> bool {
    MODE.load(Ordering::SeqCst) == OPEN
}

pub fn hwnd() -> isize {
    PANE_HWND.load(Ordering::SeqCst)
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    if let Some(pane) = app.get_webview_window("pane") {
        let h = pane.hwnd()?.0 as isize;
        PANE_HWND.store(h, Ordering::SeqCst);
        win::make_tool_window(h, false);
        win::disable_transitions(h);
        win::set_click_through(h, true);
        win::on_app_command(h, crate::keyboard::app_command);
    }
    Ok(())
}

/// Leave `from` for `to`, if the window is still in `from`.
fn switch(from: u8, to: u8) -> bool {
    let ok = MODE.compare_exchange(from, to, Ordering::SeqCst, Ordering::SeqCst).is_ok();
    if ok {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        LAST_SENT.store(u32::MAX, Ordering::SeqCst);
    }
    ok
}

/// Show the (still click-through, see-through) window over the whole primary
/// monitor without taking focus. Re-measured every time in case the
/// resolution or scaling changed.
fn show_window(app: &AppHandle) {
    let h = hwnd();
    if h == 0 {
        return;
    }
    if let Ok(Some(m)) = app.primary_monitor() {
        let (pos, size) = (m.position(), m.size());
        win::show_at_no_activate(h, pos.x, pos.y, size.width as i32, size.height as i32);
    }
}

/// Hide the window once it has slid away, unless something else happened since.
fn hide_later(app: &AppHandle) {
    let generation = GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(HIDE_AFTER);
        if GENERATION.load(Ordering::SeqCst) == generation && switch(CLOSING, HIDDEN) {
            win::hide(hwnd());
            let _ = app.emit_to("pane", "pane-hidden", ());
        }
    });
}

/// Send a slide amount (CSS px) to the page, skipping tiny changes.
fn send(app: &AppHandle, event: &str, px: f64) {
    let px = px as f32;
    let last = f32::from_bits(LAST_SENT.load(Ordering::SeqCst));
    if LAST_SENT.load(Ordering::SeqCst) != u32::MAX && (px - last).abs() < 0.5 {
        return;
    }
    LAST_SENT.store(px.to_bits(), Ordering::SeqCst);
    let _ = app.emit_to("pane", event, px);
}

/// Cursor near the left edge (pane not open): show `px` of the pane's edge.
pub fn peek(app: &AppHandle, px: f64) {
    loop {
        match MODE.load(Ordering::SeqCst) {
            // (A glance isn't interrupted by the mouse nearing the edge.)
            OPEN | GLANCE => return,
            PEEK => break,
            from => {
                if switch(from, PEEK) {
                    if from == HIDDEN {
                        show_window(app);
                    }
                    break;
                }
            }
        }
    }
    send(app, "pane-peek", px);
}

/// Cursor left the edge: slide the peeking edge back in, then hide.
pub fn unpeek(app: &AppHandle) {
    if switch(PEEK, CLOSING) {
        let _ = app.emit_to("pane", "pane-peek", 0.0f32);
        hide_later(app);
    }
}

/// Pane open and the mouse pushing into the right edge: slide the pane back
/// by `px`, as a hint that pushing further will close it.
pub fn pull(app: &AppHandle, px: f64) {
    if is_open() {
        send(app, "pane-pull", px);
    }
}

/// Partly open the pane (unfocused) to show `kind`; the page slides it out.
/// Does nothing, and returns false, if the pane is fully open.
pub fn glance(app: &AppHandle, kind: Glance) -> bool {
    loop {
        match MODE.load(Ordering::SeqCst) {
            OPEN => return false,
            GLANCE => break,
            from => {
                if switch(from, GLANCE) {
                    if from == HIDDEN {
                        show_window(app);
                    }
                    break;
                }
            }
        }
    }
    GLANCE_KIND.store(kind as u8, Ordering::SeqCst);
    true
}

/// Whether the pane is glancing at `kind` right now.
pub fn is_glancing(kind: Glance) -> bool {
    MODE.load(Ordering::SeqCst) == GLANCE && GLANCE_KIND.load(Ordering::SeqCst) == kind as u8
}

/// End a glance at `kind` (if that is still what's showing): slide away, then hide.
pub fn unglance(app: &AppHandle, kind: Glance) {
    if GLANCE_KIND.load(Ordering::SeqCst) == kind as u8 && switch(GLANCE, CLOSING) {
        let _ = app.emit_to("pane", "pane-unglance", ());
        hide_later(app);
    }
}

pub fn open(app: &AppHandle) {
    crate::debug_log::log("pane: open");
    let from = MODE.load(Ordering::SeqCst);
    if from == OPEN || !switch(from, OPEN) {
        return;
    }
    REVEALED.store(false, Ordering::SeqCst);

    // Remember what was in front, to hand focus back on close.
    let prev = win::foreground();
    if prev != hwnd() {
        PREVIOUS.store(prev, Ordering::SeqCst);
    }

    if from == HIDDEN {
        show_window(app);
    }
    let _ = app.emit_to("pane", "pane-opening", ());
    apps::refresh_in_background();

    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(REVEAL_FALLBACK);
        reveal(&app);
    });
}

/// Make the pane interactive and focus it (once per open).
fn reveal(_app: &AppHandle) {
    if !is_open() || REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    let h = hwnd();
    win::set_click_through(h, false);
    win::force_foreground(h);
}

pub fn close(app: &AppHandle) {
    crate::debug_log::log("pane: close");
    if !switch(OPEN, CLOSING) {
        return;
    }
    let h = hwnd();
    // Clicks go straight through to whatever is behind while it slides away.
    win::set_click_through(h, true);
    // Lets the page slide out and stop work it only does while open.
    let _ = app.emit_to("pane", "pane-closing", ());
    // Give focus back to the app the user was in, rather than letting
    // Windows pick (with the taskbar hidden it can land on the shell).
    let was_front = h == win::foreground();
    let prev = PREVIOUS.swap(0, Ordering::SeqCst);
    if was_front && prev != 0 {
        win::activate(prev);
    }
    hide_later(app);
}

/// Close after launching an app: don't hand focus back to the previous
/// window, so the newly launched app can take it.
pub fn close_for_launch(app: &AppHandle) {
    PREVIOUS.store(0, Ordering::SeqCst);
    close(app);
}

/// Called when the pane reports losing focus. That also happens when focus just
/// moves into the pane's own web content, so check what is really in front.
pub fn close_if_not_foreground(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(50));
        if !is_open() || !REVEALED.load(Ordering::SeqCst) {
            return;
        }
        if win::foreground() != hwnd() {
            close(&app);
        }
    });
}

pub fn toggle(app: &AppHandle) {
    if is_open() {
        close(app);
    } else {
        open(app);
    }
}

#[tauri::command]
pub fn hide_pane(app: AppHandle) {
    close(&app);
}

/// Identifies the current wallpaper (path + last-modified time), so the page
/// only reloads the image when it actually changed. Empty if there is none.
#[tauri::command]
pub fn wallpaper_key() -> String {
    let Some(path) = win::wallpaper_path() else {
        return String::new();
    };
    let modified = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    format!("{path}|{modified}")
}

/// The wallpaper image file's bytes. Empty if there is none.
#[tauri::command]
pub fn get_wallpaper() -> Response {
    let data = win::wallpaper_path()
        .and_then(|p| std::fs::read(p).ok())
        .unwrap_or_default();
    Response::new(data)
}

/// Called by the page once the background is drawn; the page slides the
/// pane in once this returns.
#[tauri::command]
pub fn reveal_pane(app: AppHandle) {
    reveal(&app);
}
