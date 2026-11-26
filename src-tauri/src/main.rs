// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod calendar;
mod debug_log;
mod dnd;
mod edge;
mod keyboard;
mod library;
mod media;
mod pane;
mod settings;
mod switcher;
mod system;
mod taskbar;
mod weather;
mod win;

use tauri::{Manager, RunEvent, WindowEvent};

/// Give the user back what The Pane changed while running: the taskbar and
/// their Do Not Disturb setting.
pub fn restore_windows() {
    taskbar::restore();
    dnd::restore();
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    restore_windows();
    app.exit(0);
}

fn main() {
    // Whatever happens, try hard to give the user their taskbar back.
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_windows();
        default_panic(info);
    }));
    win::on_console_close(restore_windows);

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
            pane::wallpaper_key,
            pane::get_wallpaper,
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
            system::open_windows_settings,
            system::get_battery,
            settings::get_settings,
            settings::save_settings,
            weather::zip_location,
            weather::open_forecast_page,
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
            taskbar::hide();
            dnd::turn_on();
            apps::refresh_in_background();
            keyboard::install(handle.clone());
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

    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            restore_windows();
        }
    });
}
