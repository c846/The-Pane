//! Watches the mouse at the screen edges.
//!
//! Pane closed, left edge:
//! - Near the edge -> the edge of the pane pops out ("peek").
//! - Pinned against the edge and pushing further left -> builds up "pressure",
//!   which slides the pane further out; enough pressure opens it.
//!
//! Pane open, right edge:
//! - Pinned against the edge and pushing further right -> the same pressure
//!   slides the pane back, and enough of it closes the pane.
//!
//! Once the cursor is at the edge it can't move further, so pressure is
//! measured from raw mouse movement (Raw Input), which keeps reporting how far
//! the mouse is pushed even when the cursor is stuck.

use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEMOUSE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, HWND_MESSAGE,
    MSG, WM_INPUT, WNDCLASSW,
};

use crate::{pane, win};

const POLL_INTERVAL: Duration = Duration::from_millis(15);
const REFRESH_INTERVAL: Duration = Duration::from_secs(1);
/// How close (logical px) the cursor must be for the pane's edge to pop out.
const PEEK_ZONE: f64 = 24.0;
/// How far (logical px) the pane's edge pops out.
const PEEK_WIDTH: f64 = 5.0;
/// How much further (logical px) pressure slides the pane just before it
/// opens (or, when open, how far back it slides just before it closes).
const PRESSURE_SLIDE: f64 = 90.0;
/// How far (raw mouse units) you must push into the edge to open the pane
/// (left edge) or close it (right edge). Higher = more pressure needed.
const PUSH_TO_TOGGLE: i32 = 150;
/// Pushing stops counting if the mouse rests this long; pressure then resets.
const PUSH_TIMEOUT_MS: u64 = 250;
/// Movement in the first moments at the edge is just the motion that got the
/// cursor there, not a deliberate push, so it is ignored.
const SETTLE_MS: u64 = 80;

/// Which edge the cursor is pinned against (see `set_edge`), and since when.
static PUSH_EDGE: AtomicI32 = AtomicI32::new(0);
static AT_EDGE_SINCE_MS: AtomicU64 = AtomicU64::new(0);
/// Accumulated push into the edge, and when the last push happened.
static PRESSURE: AtomicI32 = AtomicI32::new(0);
static LAST_PUSH_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

#[derive(Clone, Copy)]
struct Screen {
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    scale: f64,
}

fn read_screen(app: &AppHandle) -> Option<Screen> {
    let m = app.primary_monitor().ok()??;
    Some(Screen {
        left: m.position().x,
        top: m.position().y,
        width: m.size().width as i32,
        height: m.size().height as i32,
        scale: m.scale_factor(),
    })
}

pub fn start(app: AppHandle) {
    start_pressure_sensor();
    thread::spawn(move || {
        let mut screen: Option<Screen> = None;
        let mut last_refresh: Option<Instant> = None;
        loop {
            if last_refresh.map_or(true, |t| t.elapsed() >= REFRESH_INTERVAL) {
                screen = read_screen(&app).or(screen);
                last_refresh = Some(Instant::now());
            }
            if let Some(s) = screen {
                tick(&app, &s);
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Which edge the cursor is pinned against: LEFT (pane closed), RIGHT (pane
/// open) or NONE. The pressure sensor counts movement in that direction.
const NONE: i32 = 0;
const LEFT: i32 = -1;
const RIGHT: i32 = 1;

fn set_edge(edge: i32) {
    let previous = PUSH_EDGE.swap(edge, Ordering::SeqCst);
    if edge != previous {
        AT_EDGE_SINCE_MS.store(now_ms(), Ordering::SeqCst);
        PRESSURE.store(0, Ordering::SeqCst);
    }
}

/// Pressure only builds while pushing steadily against the edge, and not
/// while dragging something (e.g. snapping a window, or a slider).
fn pushed_enough(edge: i32) -> bool {
    let resting = now_ms().saturating_sub(LAST_PUSH_MS.load(Ordering::SeqCst)) > PUSH_TIMEOUT_MS;
    if edge == NONE || resting || win::left_button_down() {
        PRESSURE.store(0, Ordering::SeqCst);
        return false;
    }
    if PRESSURE.load(Ordering::SeqCst) >= PUSH_TO_TOGGLE {
        PRESSURE.store(0, Ordering::SeqCst);
        return true;
    }
    false
}

/// How far the pressure built up so far slides the pane (logical px).
fn pressure_slide() -> f64 {
    let p = PRESSURE.load(Ordering::SeqCst).max(0) as f64 / PUSH_TO_TOGGLE as f64;
    p.min(1.0) * PRESSURE_SLIDE
}

fn tick(app: &AppHandle, s: &Screen) {
    let Some((x, y)) = win::cursor_pos() else {
        return;
    };
    let on_screen = y >= s.top && y < s.top + s.height && x >= s.left && x < s.left + s.width;

    // Pane open: pushing against the right edge slides it back, then closes it.
    if pane::is_open() {
        let at_right = on_screen && x >= s.left + s.width - 1;
        set_edge(if at_right { RIGHT } else { NONE });
        if pushed_enough(PUSH_EDGE.load(Ordering::SeqCst)) {
            pane::close(app);
        } else {
            pane::pull(app, pressure_slide());
        }
        return;
    }

    // Pane closed: near the left edge, the pane's edge pops out; pushing
    // against the edge slides it further, then opens it.
    let dx = x - s.left;
    let at_left = on_screen && dx <= 0;
    set_edge(if at_left { LEFT } else { NONE });

    if pushed_enough(PUSH_EDGE.load(Ordering::SeqCst)) {
        pane::open(app);
    } else if on_screen && (dx as f64) < PEEK_ZONE * s.scale {
        pane::peek(app, PEEK_WIDTH + pressure_slide());
    } else {
        pane::unpeek(app);
    }
}

/// Listens to raw mouse movement on its own thread, adding movement into the
/// edge the cursor is pinned against to PRESSURE.
fn start_pressure_sensor() {
    thread::spawn(|| unsafe {
        let class: Vec<u16> = "ThePanePressureSensor\0".encode_utf16().collect();
        let instance = GetModuleHandleW(std::ptr::null());
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(sensor_proc);
        wc.hInstance = instance;
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc);
        // An invisible, message-only window to receive raw input.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            eprintln!("The Pane: could not create the edge pressure sensor");
            return;
        }
        let device = RAWINPUTDEVICE {
            usUsagePage: 0x01, // generic desktop
            usUsage: 0x02,     // mouse
            dwFlags: RIDEV_INPUTSINK, // receive input even when not focused
            hwndTarget: hwnd,
        };
        if RegisterRawInputDevices(&device, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32) == 0 {
            eprintln!("The Pane: could not listen to raw mouse input");
            return;
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            DispatchMessageW(&msg);
        }
    });
}

unsafe extern "system" fn sensor_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let edge = PUSH_EDGE.load(Ordering::SeqCst);
    if msg == WM_INPUT && edge != NONE {
        let mut raw: RAWINPUT = std::mem::zeroed();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let read = GetRawInputData(
            lparam as HRAWINPUT,
            RID_INPUT,
            &mut raw as *mut _ as *mut _,
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        );
        const MOUSE_MOVE_ABSOLUTE: u16 = 0x01;
        if read != u32::MAX && raw.header.dwType == RIM_TYPEMOUSE {
            let mouse = raw.data.mouse;
            let settled = now_ms().saturating_sub(AT_EDGE_SINCE_MS.load(Ordering::SeqCst)) >= SETTLE_MS;
            // Only movement into the edge counts (left for LEFT, right for RIGHT).
            let into_edge = mouse.lLastX * edge;
            if mouse.usFlags & MOUSE_MOVE_ABSOLUTE == 0 && into_edge > 0 && settled {
                PRESSURE.fetch_add(into_edge, Ordering::SeqCst);
                LAST_PUSH_MS.store(now_ms(), Ordering::SeqCst);
            }
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}
