//! Keyboard handling, all on one thread:
//!
//! - The Home key toggles the pane (a normal RegisterHotKey hotkey; while The
//!   Pane runs, Home is reserved for it in every app).
//! - A low-level keyboard hook that takes over keys from Windows:
//!   - Volume keys set the volume here and show The Pane's own volume
//!     popup, so Windows' volume flyout never appears.
//!   - Alt+Space opens The Pane's window switcher (see switcher.rs): keep
//!     holding Alt and press Space to move on (Shift+Space moves back), let
//!     go of Alt to switch, Esc to cancel.
//!   - Windows shortcuts are swallowed: the Windows key (and so every Win+…
//!     shortcut), Alt+Tab, Alt+Esc, Ctrl+Esc and Ctrl+Shift+Esc.
//!     Ctrl+Alt+Del can't be intercepted, so it always still works.
//!
//! The hook must answer quickly: if it ever keeps Windows waiting (about
//! 300ms), Windows silently removes it for good, and every shortcut above
//! goes back to Windows. So the hook's thread does nothing but run the hook
//! (the hotkey only posts it a message); everything else, even toggling the
//! pane, is handed to a worker thread. As a safety net the hook is also
//! re-installed every few seconds, since Windows never says it removed one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;

use tauri::AppHandle;
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, RegisterHotKey, SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP,
    MOD_NOREPEAT, VK_CONTROL, VK_ESCAPE, VK_HOME, VK_LMENU, VK_LWIN, VK_MENU, VK_RMENU, VK_RWIN,
    VK_SHIFT, VK_SPACE, VK_TAB, VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION,
    KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, MSG, WH_KEYBOARD_LL, WM_HOTKEY, WM_KEYDOWN, WM_SYSKEYDOWN,
    WM_TIMER,
};

use crate::system::VolumeKey;
use crate::{pane, switcher, system};

const HOTKEY_ID: i32 = 1;
/// An unassigned virtual key. Tapped while Alt is down so that letting go of
/// Alt doesn't open the menu bar of the app in front.
const VK_MASK: u16 = 0xE8;
/// Marks key presses The Pane sends itself, so the hook lets them through.
/// (Other software-sent keys are handled like real ones: keyboard and laptop
/// utilities often send the volume keys that way.)
pub const OUR_INPUT: usize = 0x5041_4E45;
/// How often the hook is re-installed, in case Windows removed it.
const REARM_EVERY_MS: u32 = 5_000;

enum Action {
    TogglePane,
    Volume(VolumeKey),
    SwitcherStart { back: bool },
    SwitcherStep { back: bool },
    SwitcherFinish,
    SwitcherCancel,
}

static ACTIONS: OnceLock<Sender<Action>> = OnceLock::new();
/// Alt+Space started the switcher and Alt hasn't been let go yet.
static SWITCHING: AtomicBool = AtomicBool::new(false);
/// A Space press was swallowed; swallow its release too.
static SPACE_DOWN: AtomicBool = AtomicBool::new(false);

pub fn install(app: AppHandle) {
    let (tx, rx) = channel::<Action>();
    let _ = ACTIONS.set(tx);

    // Does the work the hook hands over.
    let worker_app = app;
    thread::spawn(move || {
        for action in rx {
            let app = &worker_app;
            match action {
                Action::TogglePane => {
                    let started = std::time::Instant::now();
                    pane::toggle(app);
                    crate::debug_log::log(format!("toggle took {} ms", started.elapsed().as_millis()));
                }
                Action::Volume(key) => system::volume_key(app, key),
                Action::SwitcherStart { back } => switcher::start(app, back),
                Action::SwitcherStep { back } => switcher::step(app, back),
                Action::SwitcherFinish => switcher::finish(app),
                Action::SwitcherCancel => switcher::cancel(app),
            }
        }
    });

    // The hook's thread. The hotkey, the hook and the re-arm timer all belong
    // to it, so their messages and calls arrive through this loop, which
    // must never block (see the top of this file).
    thread::spawn(|| unsafe {
        if RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, MOD_NOREPEAT, VK_HOME as u32) == 0 {
            eprintln!("The Pane: could not register the Home hotkey (is another app using it?)");
        }
        let install_hook =
            || SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), GetModuleHandleW(std::ptr::null()), 0);
        let mut hook = install_hook();
        crate::debug_log::log(format!("keyboard hook installed: {}", !hook.is_null()));
        if hook.is_null() {
            eprintln!("The Pane: could not install the keyboard hook");
        }
        SetTimer(std::ptr::null_mut(), 0, REARM_EVERY_MS, None);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            match msg.message {
                WM_HOTKEY if msg.wParam == HOTKEY_ID as usize => send(Action::TogglePane),
                // Install a fresh hook before removing the old one, so no
                // key slips through in between.
                WM_TIMER => {
                    let fresh = install_hook();
                    if !fresh.is_null() {
                        if !hook.is_null() {
                            UnhookWindowsHookEx(hook);
                        }
                        hook = fresh;
                    }
                }
                _ => {}
            }
        }
    });
}

fn send(action: Action) {
    if let Some(tx) = ACTIONS.get() {
        let _ = tx.send(action);
    }
}

/// A WM_APPCOMMAND reached the pane window (see win::on_app_command):
/// handle the volume ones like the volume keys, so Windows doesn't.
pub fn app_command(command: u32) -> bool {
    const APPCOMMAND_VOLUME_MUTE: u32 = 8;
    const APPCOMMAND_VOLUME_DOWN: u32 = 9;
    const APPCOMMAND_VOLUME_UP: u32 = 10;
    crate::debug_log::log(format!("app command {command} (pane open: {})", pane::is_open()));
    let key = match command {
        APPCOMMAND_VOLUME_UP => VolumeKey::Up,
        APPCOMMAND_VOLUME_DOWN => VolumeKey::Down,
        APPCOMMAND_VOLUME_MUTE => VolumeKey::Mute,
        _ => return false,
    };
    send(Action::Volume(key));
    true
}

fn key_down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
}

/// Tap VK_MASK (see there).
fn mask_alt() {
    unsafe {
        let mut inputs: [INPUT; 2] = std::mem::zeroed();
        for (i, input) in inputs.iter_mut().enumerate() {
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki.wVk = VK_MASK;
            input.Anonymous.ki.dwFlags = if i == 1 { KEYEVENTF_KEYUP } else { 0 };
            input.Anonymous.ki.dwExtraInfo = OUR_INPUT;
        }
        SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(lparam as *const KBDLLHOOKSTRUCT);
        // Diagnostics (debug builds): volume and media keys only, never typing.
        if (0xAD..=0xB7).contains(&k.vkCode) {
            crate::debug_log::log(format!(
                "hook: vk={:#x} msg={:#x} flags={:#x} extra={:#x} pane_open={}",
                k.vkCode, wparam, k.flags, k.dwExtraInfo, pane::is_open()
            ));
        }
        // Keys The Pane sends itself (mask taps) pass through.
        if k.dwExtraInfo != OUR_INPUT && swallow(k.vkCode as u16, wparam as u32, k.flags) {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Whether to keep a key event from Windows and apps (doing our own thing
/// with it instead).
fn swallow(vk: u16, msg: u32, flags: u32) -> bool {
    let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
    let alt = flags & LLKHF_ALTDOWN != 0;
    match vk {
        VK_VOLUME_UP | VK_VOLUME_DOWN | VK_VOLUME_MUTE => {
            if down {
                send(Action::Volume(match vk {
                    VK_VOLUME_UP => VolumeKey::Up,
                    VK_VOLUME_DOWN => VolumeKey::Down,
                    _ => VolumeKey::Mute,
                }));
            }
            true
        }

        // The Windows key, and with it every Win+… shortcut.
        VK_LWIN | VK_RWIN => true,

        VK_SPACE if alt || SPACE_DOWN.load(Ordering::SeqCst) => {
            if !down {
                SPACE_DOWN.store(false, Ordering::SeqCst);
                return true;
            }
            SPACE_DOWN.store(true, Ordering::SeqCst);
            if alt {
                mask_alt();
                let back = key_down(VK_SHIFT);
                if SWITCHING.swap(true, Ordering::SeqCst) {
                    send(Action::SwitcherStep { back });
                } else {
                    send(Action::SwitcherStart { back });
                }
            }
            true
        }

        // Alt+Tab.
        VK_TAB if alt => {
            if down {
                mask_alt();
            }
            true
        }

        VK_ESCAPE => {
            if alt && SWITCHING.load(Ordering::SeqCst) {
                if down {
                    mask_alt();
                    SWITCHING.store(false, Ordering::SeqCst);
                    send(Action::SwitcherCancel);
                }
                true
            } else if alt {
                // Alt+Esc.
                if down {
                    mask_alt();
                }
                true
            } else {
                // Ctrl+Esc (Start) and Ctrl+Shift+Esc (Task Manager).
                key_down(VK_CONTROL)
            }
        }

        // Letting go of Alt picks the selected window.
        VK_MENU | VK_LMENU | VK_RMENU if !down => {
            if SWITCHING.swap(false, Ordering::SeqCst) {
                send(Action::SwitcherFinish);
            }
            false
        }

        _ => false,
    }
}
