//! ZIP code -> latitude/longitude, for looking up the weather.
//!
//! weather.gov only accepts coordinates. Rather than sending the ZIP code to a
//! third-party geocoding service, the lookup is done offline against the US
//! Census Bureau's ZIP Code Tabulation Area table (2024 Gazetteer, public
//! domain), trimmed to "zip,lat,lon" lines in data/zip-locations.csv.
//! Some ZIP codes used only for PO boxes or single buildings aren't in it.

use serde::Serialize;

static ZIP_TABLE: &str = include_str!("../data/zip-locations.csv");

#[derive(Serialize)]
pub struct Location {
    lat: f64,
    lon: f64,
}

/// Open weather.gov's full forecast page for a location (closes the pane).
#[tauri::command]
pub fn open_forecast_page(app: tauri::AppHandle, lat: f64, lon: f64) {
    if lat.is_finite() && lon.is_finite() {
        let url = format!("https://forecast.weather.gov/MapClick.php?lat={lat:.4}&lon={lon:.4}");
        crate::apps::shell_open_from_pane(&app, &url);
    }
}

#[tauri::command]
pub fn zip_location(zip: String) -> Option<Location> {
    let zip = zip.trim();
    if zip.len() != 5 || !zip.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let line = ZIP_TABLE.lines().find(|l| l.starts_with(zip) && l.as_bytes().get(5) == Some(&b','))?;
    let mut parts = line.split(',').skip(1);
    let lat = parts.next()?.parse().ok()?;
    let lon = parts.next()?.parse().ok()?;
    Some(Location { lat, lon })
}
