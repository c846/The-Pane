// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod calendar;
mod debug_log;
mod desktop;
mod edge;
mod explorer;
mod frame;
mod instance;
mod keyboard;
mod library;
mod media;
mod pane;
mod settings;
mod switcher;
mod system;
mod weather;
mod widgets;
mod win;

use tauri::{Manager, WindowEvent};

/// Quitting on purpose brings Explorer back, so the screen isn't left empty.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    frame::restore();
    explorer::restore();
    app.exit(0);
}

fn main() {
    // Take over from (or, with --quit, just stop) a copy already running.
    if !instance::claim() {
        return;
    }

    let app = tauri::Builder::default()
        // Don't let the window library register for raw keyboard input (we
        // never use its device events). While a process registered for it is
        // in front, Windows stops calling that process's low-level keyboard
        // hook, so with the pane open keyboard.rs would never see the volume
        // keys (or the Windows key, Alt+Tab, …) and Windows would handle them.
        // This also drops its raw mouse input; edge.rs registers its own
        // afterwards, in setup.
        .device_event_filter(tauri::DeviceEventFilter::Always)
        .invoke_handler(tauri::generate_handler![
            pane::hide_pane,
            desktop::wallpaper_key,
            desktop::get_wallpaper,
            desktop::pick_wallpaper,
            pane::reveal_pane,
            apps::list_apps,
            apps::app_icon,
            apps::launch_app,
            library::app_lists,
            library::set_favorite,
            library::move_favorite,
            library::forget_recent,
            system::get_volume,
            system::set_volume,
            system::set_muted,
            system::get_brightness,
            system::set_brightness,
            system::power,
            explorer::open_windows_settings,
            explorer::windows_shell_running,
            explorer::start_windows_shell,
            explorer::stop_windows_shell,
            system::get_battery,
            settings::get_settings,
            settings::save_settings,
            weather::zip_location,
            weather::open_forecast_page,
            widgets::get_widgets,
            widgets::add_widget,
            widgets::place_widget,
            widgets::remove_widget,
            widgets::lock_widgets,
            calendar::get_events,
            calendar::add_event,
            calendar::remove_event,
            media::media_sessions,
            media::media_art,
            media::media_control,
            media::media_seek,
            switcher::window_icon,
            switcher::window_preview,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            pane::init(&handle)?;
            desktop::init(&handle);
            frame::start();
            apps::refresh_in_background();
            keyboard::install(handle.clone());
            instance::quit_when_asked(handle.clone());
            // Dev aid: PANE_DEBUG_OPEN=1 opens the pane on launch (debug builds only).
            #[cfg(debug_assertions)]
            if std::env::var("PANE_DEBUG_OPEN").is_ok() {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    pane::open(&h);
                });
            }
            edge::start(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "pane" {
                return;
            }
            #[cfg(debug_assertions)]
            eprintln!("[pane] window event: {event:?}");
            match event {
                // Clicking anywhere outside the pane closes it.
                WindowEvent::Focused(false) => pane::close_if_not_foreground(window.app_handle()),
                // Alt+F4 just hides the pane instead of destroying it.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    pane::close(window.app_handle());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building The Pane");

    app.run(|_app, _event| {});
}
