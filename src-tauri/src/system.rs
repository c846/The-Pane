//! PC controls for the bottom-left quadrant: volume, brightness, power and
//! opening Windows Settings.
//!
//! Volume and brightness go through COM (Core Audio and WMI). All COM work
//! runs on one dedicated thread, which keeps the WMI connection open between
//! calls so dragging a slider stays responsive.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{BSTR, PCWSTR};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
    COINIT_MULTITHREADED, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Variant::{VariantClear, VariantToInt32, VariantToString, VARIANT, VT_I4, VT_UI1};
use windows::Win32::System::Wmi::{
    IWbemClassObject, IWbemLocator, IWbemServices, WbemLocator, WBEM_FLAG_FORWARD_ONLY,
    WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE, WBEM_INFINITE,
};
use windows_sys::Win32::Devices::Display::{
    DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
};
use windows_sys::Win32::Foundation::{LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

use crate::pane::Glance;
use crate::{apps, pane};

// ---- COM worker thread ----------------------------------------------------------

type Job = Box<dyn FnOnce() + Send>;

fn worker() -> &'static Sender<Job> {
    static WORKER: OnceLock<Sender<Job>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            for job in rx {
                job();
            }
        });
        tx
    })
}

/// Run `f` on the COM thread and wait for its result (without blocking the
/// async runtime).
pub async fn on_com_thread<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
    let (tx, rx) = channel();
    worker()
        .send(Box::new(move || {
            let _ = tx.send(f());
        }))
        .ok()?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok())
        .await
        .ok()
        .flatten()
}

// ---- Volume ---------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct Volume {
    /// 0-100, the same scale as the Windows volume slider.
    level: u32,
    muted: bool,
}

/// The default speakers/headphones. Looked up each time, so switching output
/// devices is picked up straight away.
fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
        device.Activate(CLSCTX_ALL, None)
    }
}

fn read_volume() -> Option<Volume> {
    let ep = endpoint().ok()?;
    unsafe {
        Some(Volume {
            level: (ep.GetMasterVolumeLevelScalar().ok()? * 100.0).round() as u32,
            muted: ep.GetMute().ok()?.as_bool(),
        })
    }
}

/// Current volume, or null if there is no output device.
#[tauri::command]
pub async fn get_volume() -> Option<Volume> {
    on_com_thread(read_volume).await.flatten()
}

#[tauri::command]
pub async fn set_volume(level: u32) {
    on_com_thread(move || {
        if let Ok(ep) = endpoint() {
            unsafe {
                let _ = ep.SetMasterVolumeLevelScalar(level.min(100) as f32 / 100.0, std::ptr::null());
                // Turning the volume up unmutes, like the Windows slider does.
                if level > 0 {
                    let _ = ep.SetMute(false, std::ptr::null());
                }
            }
        }
    })
    .await;
}

// ---- Volume keys and the volume popup ------------------------------------------

pub enum VolumeKey {
    Up,
    Down,
    Mute,
}

/// Each volume key press moves the volume this much (as Windows does).
const VOLUME_STEP: u32 = 2;
/// The popup stays this long after the last press.
const POPUP_FOR: Duration = Duration::from_millis(1300);
/// Bumped on every press, so only the last one's timer hides the popup.
static POPUP_GENERATION: AtomicU64 = AtomicU64::new(0);

/// A volume key was pressed (keyboard.rs keeps it from Windows): change the
/// volume, and show the new level in the popup (or, if the pane is open, on
/// its volume slider).
pub fn volume_key(app: &AppHandle, key: VolumeKey) {
    crate::debug_log::log("volume_key: changing the volume");
    let app = app.clone();
    let _ = worker().send(Box::new(move || {
        let Ok(ep) = endpoint() else {
            return;
        };
        unsafe {
            let level = (ep.GetMasterVolumeLevelScalar().unwrap_or(0.0) * 100.0).round() as u32;
            let muted = ep.GetMute().map(|m| m.as_bool()).unwrap_or(false);
            match key {
                VolumeKey::Mute => {
                    let _ = ep.SetMute(!muted, std::ptr::null());
                }
                // Step to the next even level, and unmute, like Windows does.
                VolumeKey::Up | VolumeKey::Down => {
                    let next = match key {
                        VolumeKey::Up => (level / VOLUME_STEP + 1) * VOLUME_STEP,
                        _ => ((level + 1) / VOLUME_STEP).saturating_sub(1) * VOLUME_STEP,
                    };
                    let _ = ep.SetMasterVolumeLevelScalar(next.min(100) as f32 / 100.0, std::ptr::null());
                    let _ = ep.SetMute(false, std::ptr::null());
                }
            }
        }
        let Some(volume) = read_volume() else {
            return;
        };
        if !pane::glance(&app, Glance::Volume) {
            let _ = app.emit_to("pane", "volume-changed", volume);
            return;
        }
        let _ = app.emit_to("pane", "volume-popup", volume);
        let generation = POPUP_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            std::thread::sleep(POPUP_FOR);
            if POPUP_GENERATION.load(Ordering::SeqCst) == generation {
                pane::unglance(&app, Glance::Volume);
            }
        });
    }));
}

#[tauri::command]
pub async fn set_muted(muted: bool) {
    on_com_thread(move || {
        if let Ok(ep) = endpoint() {
            unsafe {
                let _ = ep.SetMute(muted, std::ptr::null());
            }
        }
    })
    .await;
}

// ---- Brightness ----------------------------------------------------------------
//
// Built-in laptop screens are controlled through WMI; external monitors
// through DDC/CI (if the monitor supports it). One slider sets all of them.

thread_local! {
    /// The WMI connection, kept open on the COM thread.
    static WMI: std::cell::OnceCell<Option<IWbemServices>> = const { std::cell::OnceCell::new() };
}

fn wmi() -> Option<IWbemServices> {
    WMI.with(|cell| {
        cell.get_or_init(|| unsafe {
            let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER).ok()?;
            let services = locator
                .ConnectServer(&BSTR::from("ROOT\\WMI"), &BSTR::new(), &BSTR::new(), &BSTR::new(), 0, &BSTR::new(), None)
                .ok()?;
            const RPC_C_AUTHN_WINNT: u32 = 10;
            const RPC_C_AUTHZ_NONE: u32 = 0;
            CoSetProxyBlanket(
                &services,
                RPC_C_AUTHN_WINNT,
                RPC_C_AUTHZ_NONE,
                PCWSTR::null(),
                RPC_C_AUTHN_LEVEL_CALL,
                RPC_C_IMP_LEVEL_IMPERSONATE,
                None,
                EOAC_NONE,
            )
            .ok()?;
            Some(services)
        })
        .clone()
    })
}

/// The first object a WMI query returns.
fn wmi_first(services: &IWbemServices, query: &str) -> Option<IWbemClassObject> {
    unsafe {
        let flags = WBEM_GENERIC_FLAG_TYPE(WBEM_FLAG_FORWARD_ONLY.0 | WBEM_FLAG_RETURN_IMMEDIATELY.0);
        let results = services.ExecQuery(&BSTR::from("WQL"), &BSTR::from(query), flags, None).ok()?;
        let mut row = [None];
        let mut returned = 0;
        results.Next(WBEM_INFINITE, &mut row, &mut returned).ok().ok()?;
        row[0].take()
    }
}

fn wmi_get(obj: &IWbemClassObject, name: &str) -> Option<VARIANT> {
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let mut value = VARIANT::default();
    unsafe { obj.Get(PCWSTR(name.as_ptr()), 0, &mut value, None, None).ok()? };
    Some(value)
}

fn wmi_put(obj: &IWbemClassObject, name: &str, value: &VARIANT) -> Option<()> {
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    unsafe { obj.Put(PCWSTR(name.as_ptr()), 0, value, 0).ok() }
}

fn variant_u8(x: u8) -> VARIANT {
    let mut v = VARIANT::default();
    unsafe {
        (*v.Anonymous.Anonymous).vt = VT_UI1;
        (*v.Anonymous.Anonymous).Anonymous.bVal = x;
    }
    v
}

/// WMI passes uint32 values as VT_I4.
fn variant_i32(x: i32) -> VARIANT {
    let mut v = VARIANT::default();
    unsafe {
        (*v.Anonymous.Anonymous).vt = VT_I4;
        (*v.Anonymous.Anonymous).Anonymous.lVal = x;
    }
    v
}

fn laptop_brightness() -> Option<u32> {
    let services = wmi()?;
    let obj = wmi_first(&services, "SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE Active = TRUE")?;
    let mut value = wmi_get(&obj, "CurrentBrightness")?;
    let level = unsafe { VariantToInt32(&value).ok() };
    unsafe {
        let _ = VariantClear(&mut value);
    }
    level.map(|l| l.clamp(0, 100) as u32)
}

fn set_laptop_brightness(level: u32) -> Option<()> {
    let services = wmi()?;
    let instance = wmi_first(&services, "SELECT * FROM WmiMonitorBrightnessMethods WHERE Active = TRUE")?;
    let mut path_var = wmi_get(&instance, "__PATH")?;
    let mut buf = [0u16; 512];
    let path = unsafe { VariantToString(&path_var, &mut buf).ok() };
    unsafe {
        let _ = VariantClear(&mut path_var);
    }
    path?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let path = BSTR::from_wide(&buf[..len]);

    unsafe {
        let mut class = None;
        services
            .GetObject(&BSTR::from("WmiMonitorBrightnessMethods"), WBEM_GENERIC_FLAG_TYPE(0), None, Some(&mut class), None)
            .ok()?;
        let mut input_def = None;
        let set = windows::core::w!("WmiSetBrightness");
        class?.GetMethod(set, 0, &mut input_def, std::ptr::null_mut()).ok()?;
        let params = input_def?.SpawnInstance(0).ok()?;
        wmi_put(&params, "Timeout", &variant_i32(0))?;
        wmi_put(&params, "Brightness", &variant_u8(level.min(100) as u8))?;
        services
            .ExecMethod(&path, &BSTR::from("WmiSetBrightness"), WBEM_GENERIC_FLAG_TYPE(0), None, &params, None, None)
            .ok()
    }
}

/// Every physical monitor Windows can talk to over DDC/CI.
fn with_external_monitors<R>(f: impl Fn(&PHYSICAL_MONITOR) -> Option<R>) -> Vec<R> {
    unsafe extern "system" fn collect(m: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> windows_sys::core::BOOL {
        (*(list as *mut Vec<HMONITOR>)).push(m);
        1
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    let mut results = Vec::new();
    unsafe {
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(collect), &mut handles as *mut _ as LPARAM);
        for h in handles {
            let mut count = 0u32;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(h, &mut count) == 0 || count == 0 {
                continue;
            }
            let mut monitors = vec![std::mem::zeroed::<PHYSICAL_MONITOR>(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(h, count, monitors.as_mut_ptr()) == 0 {
                continue;
            }
            results.extend(monitors.iter().filter_map(&f));
            DestroyPhysicalMonitors(count, monitors.as_ptr());
        }
    }
    results
}

fn external_brightness() -> Option<u32> {
    with_external_monitors(|m| unsafe {
        let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
        (GetMonitorBrightness(m.hPhysicalMonitor, &mut min, &mut cur, &mut max) != 0 && max > min)
            .then(|| (cur.saturating_sub(min)) * 100 / (max - min))
    })
    .into_iter()
    .next()
}

fn set_external_brightness(level: u32) {
    with_external_monitors(|m| unsafe {
        let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
        if GetMonitorBrightness(m.hPhysicalMonitor, &mut min, &mut cur, &mut max) != 0 && max > min {
            SetMonitorBrightness(m.hPhysicalMonitor, min + (max - min) * level.min(100) / 100);
        }
        Some(())
    });
}

/// Current brightness 0-100, or null if no screen's brightness can be set.
#[tauri::command]
pub async fn get_brightness() -> Option<u32> {
    on_com_thread(|| laptop_brightness().or_else(external_brightness))
        .await
        .flatten()
}

#[tauri::command]
pub async fn set_brightness(level: u32) {
    on_com_thread(move || {
        let _ = set_laptop_brightness(level);
        set_external_brightness(level);
    })
    .await;
}

// ---- Battery -------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    percent: u8,
    charging: bool,
    plugged_in: bool,
    /// Windows' battery saver is on.
    saver: bool,
}

/// Battery level, or null on a PC without a battery.
#[tauri::command]
pub fn get_battery() -> Option<Battery> {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    const NO_BATTERY: u8 = 128;
    const CHARGING: u8 = 8;
    const UNKNOWN: u8 = 255;

    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0
        || s.BatteryFlag == UNKNOWN
        || s.BatteryFlag & NO_BATTERY != 0
        || s.BatteryLifePercent == UNKNOWN
    {
        return None;
    }
    Some(Battery {
        percent: s.BatteryLifePercent.min(100),
        charging: s.BatteryFlag & CHARGING != 0,
        plugged_in: s.ACLineStatus == 1,
        saver: s.SystemStatusFlag == 1,
    })
}

// ---- Power and Settings --------------------------------------------------------

#[tauri::command]
pub fn power(app: AppHandle, action: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Power::SetSuspendState;
    use windows_sys::Win32::System::Shutdown::{ExitWindowsEx, LockWorkStation, EWX_LOGOFF, SHTDN_REASON_FLAG_PLANNED};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let shutdown = |args: &[&str]| {
        std::process::Command::new("shutdown.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    };

    pane::close(&app);
    match action.as_str() {
        "lock" => unsafe {
            LockWorkStation();
        },
        "sleep" => unsafe {
            SetSuspendState(false, false, false);
        },
        // Leaving Windows: give the user their taskbar and notification settings back first.
        "signout" => unsafe {
            crate::restore_windows();
            ExitWindowsEx(EWX_LOGOFF, SHTDN_REASON_FLAG_PLANNED);
        },
        "restart" => {
            crate::restore_windows();
            shutdown(&["/r", "/t", "0"])?;
        }
        "shutdown" => {
            crate::restore_windows();
            shutdown(&["/s", "/t", "0"])?;
        }
        _ => return Err(format!("Unknown power action: {action}")),
    }
    Ok(())
}

#[tauri::command]
pub fn open_windows_settings(app: AppHandle) {
    apps::shell_open_from_pane(&app, "ms-settings:");
}
