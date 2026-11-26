//! Debug builds only: appends diagnostic lines to
//! %LOCALAPPDATA%\The Pane\debug.log. Does nothing in release builds.

#[cfg(debug_assertions)]
pub fn log(line: impl AsRef<str>) {
    use std::io::Write;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};
    static LOCK: Mutex<()> = Mutex::new(());
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let path = std::path::PathBuf::from(base).join("The Pane").join("debug.log");
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() % 100_000_000);
    let _guard = LOCK.lock();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{ms:>9} {}", line.as_ref());
    }
}

#[cfg(not(debug_assertions))]
pub fn log(_line: impl AsRef<str>) {}
