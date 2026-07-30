// Screen color sampling for the color picker.
//
// The web client's first implementation used the browser EyeDropper API, which
// works but drags a magnifier overlay across the desktop; on a multi-monitor
// setup its continuous screen capture made picking visibly laggy. This reads the
// one pixel actually being asked about instead — a GDI `GetPixel` against the
// screen DC, which costs microseconds and captures nothing.
//
// `GetPixel` on the screen DC reads the *composited* desktop, so it sees other
// applications' windows, not just ours, and the coordinate space is the virtual
// screen spanning every monitor. That is what makes this usable outside the app.
//
// Windows-only. Everything else falls back to the EyeDropper path in the web
// client (apps/web/src/color/screenDropper.ts), which is why the commands report
// support rather than failing to exist.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, PeekMessageW, SetWindowsHookExW,
        UnhookWindowsHookEx, HC_ACTION, MSG, MSLLHOOKSTRUCT, PM_REMOVE, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    /// No click seen yet.
    const IDLE: u8 = 0;
    /// A left click landed; `PICK_X`/`PICK_Y` hold where.
    const PICKED: u8 = 1;
    /// The user backed out with a right click.
    const CANCELLED: u8 = 2;

    // The hook callback is a bare `extern "system"` function with nowhere to hang
    // state, so the handshake with the waiting loop goes through statics. Only one
    // pick can be in flight at a time (`SESSION`), so there is no ambiguity about
    // which session these belong to.
    static STATE: AtomicU8 = AtomicU8::new(IDLE);
    static PICK_X: AtomicI32 = AtomicI32::new(0);
    static PICK_Y: AtomicI32 = AtomicI32::new(0);
    static SESSION: AtomicBool = AtomicBool::new(false);

    /// How often the wait loop pumps messages and re-checks for Escape. The hook
    /// itself is event-driven; this only bounds how fast a cancel is noticed.
    const POLL: Duration = Duration::from_millis(8);

    /// Backstop so a session that is somehow never clicked or cancelled cannot
    /// leave a global mouse hook installed. In practice the first click always
    /// ends the session, so this only covers the user walking away.
    const TIMEOUT: Duration = Duration::from_secs(60);

    /// Clears the in-flight flag however the pick ends, including on an error path.
    struct SessionGuard;

    impl Drop for SessionGuard {
        fn drop(&mut self) {
            SESSION.store(false, Ordering::Release);
        }
    }

    /// Format a COLORREF as CSS `#rrggbb`.
    ///
    /// The one place this is easy to get silently wrong: COLORREF is `0x00bbggrr`,
    /// so the byte order is the reverse of the hex string. Reading it as RGB
    /// yields a plausible-looking color that is simply the wrong one.
    fn colorref_to_hex(raw: u32) -> String {
        let r = raw & 0xff;
        let g = (raw >> 8) & 0xff;
        let b = (raw >> 16) & 0xff;
        format!("#{r:02x}{g:02x}{b:02x}")
    }

    /// Read one desktop pixel as `#rrggbb`.
    fn pixel_at(x: i32, y: i32) -> Result<String, String> {
        // SAFETY: GetDC(None) yields a DC for the whole virtual screen; it is
        // released on both exits below, and GetPixel only reads from it.
        unsafe {
            let hdc = GetDC(None);
            if hdc.is_invalid() {
                return Err("Could not open a screen device context.".into());
            }
            let color = GetPixel(hdc, x, y);
            ReleaseDC(None, hdc);

            if color.0 == CLR_INVALID {
                return Err("That point is not on any screen.".into());
            }
            Ok(colorref_to_hex(color.0))
        }
    }

    pub fn color_at_cursor() -> Result<String, String> {
        let mut point = POINT::default();
        // SAFETY: `point` is a valid, properly aligned out-parameter.
        unsafe { GetCursorPos(&mut point) }.map_err(|e| format!("Cursor unavailable: {e}"))?;
        pixel_at(point.x, point.y)
    }

    /// Low-level mouse hook: records the pick and swallows the click.
    ///
    /// Returning a non-zero LRESULT stops the event before it reaches the window
    /// underneath, which is the whole point — sampling a color off a button in
    /// another application must not also press that button. The release events are
    /// eaten too, so nothing downstream sees a button-up without its button-down.
    ///
    /// This runs on the picking thread and must stay fast: Windows silently drops
    /// hooks that exceed `LowLevelHooksTimeout`. It only touches atomics.
    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            match wparam.0 as u32 {
                WM_LBUTTONDOWN => {
                    // SAFETY: for WH_MOUSE_LL, lparam is a valid MSLLHOOKSTRUCT
                    // owned by the caller for the duration of this call.
                    let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
                    PICK_X.store(info.pt.x, Ordering::Relaxed);
                    PICK_Y.store(info.pt.y, Ordering::Relaxed);
                    STATE.store(PICKED, Ordering::Release);
                    return LRESULT(1);
                }
                WM_RBUTTONDOWN => {
                    STATE.store(CANCELLED, Ordering::Release);
                    return LRESULT(1);
                }
                WM_LBUTTONUP | WM_RBUTTONUP if STATE.load(Ordering::Acquire) != IDLE => {
                    return LRESULT(1);
                }
                _ => {}
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// Block until the user clicks a pixel, cancels, or the backstop expires.
    ///
    /// `Ok(None)` is a cancel — ordinary flow, not a failure. Runs on its own
    /// thread because a low-level hook is only delivered to a thread that pumps
    /// messages, and that pumping must not be the UI thread.
    pub fn pick_blocking() -> Result<Option<String>, String> {
        if SESSION.swap(true, Ordering::AcqRel) {
            return Err("A screen pick is already in progress.".into());
        }
        let _session = SessionGuard;
        STATE.store(IDLE, Ordering::Release);

        // SAFETY: the hook is installed and removed on this thread, and hook_proc
        // is a valid `extern "system"` callback for WH_MOUSE_LL.
        unsafe {
            let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), None, 0)
                .map_err(|e| format!("Could not watch for the pick click: {e}"))?;

            let deadline = Instant::now() + TIMEOUT;
            let picked = loop {
                // Pumping is what lets the system deliver the hook callback; there
                // is no window here, so there is nothing else in this queue.
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    DispatchMessageW(&msg);
                }

                match STATE.load(Ordering::Acquire) {
                    PICKED => {
                        break Some((
                            PICK_X.load(Ordering::Relaxed),
                            PICK_Y.load(Ordering::Relaxed),
                        ))
                    }
                    CANCELLED => break None,
                    _ => {}
                }

                // Escape anywhere cancels. Cast to u16 first: the "currently down"
                // bit is 0x8000, which is the sign bit of the i16 this returns.
                if GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000 != 0 {
                    break None;
                }
                if Instant::now() >= deadline {
                    break None;
                }
                thread::sleep(POLL);
            };

            let _ = UnhookWindowsHookEx(hook);
            STATE.store(IDLE, Ordering::Release);

            match picked {
                Some((x, y)) => pixel_at(x, y).map(Some),
                None => Ok(None),
            }
        }
    }

    pub const SUPPORTED: bool = true;

    #[cfg(test)]
    mod tests {
        use super::colorref_to_hex;

        #[test]
        fn reads_colorref_as_bgr_not_rgb() {
            // Pure blue is 0x00ff0000 in COLORREF. Read naively as RGB it would
            // come out "#ff0000", i.e. red — the exact mistake being guarded.
            assert_eq!(colorref_to_hex(0x00ff_0000), "#0000ff");
            assert_eq!(colorref_to_hex(0x0000_00ff), "#ff0000");
            assert_eq!(colorref_to_hex(0x0000_ff00), "#00ff00");
        }

        #[test]
        fn pads_each_channel_to_two_digits() {
            assert_eq!(colorref_to_hex(0x0000_0000), "#000000");
            assert_eq!(colorref_to_hex(0x0001_0203), "#030201");
        }

        #[test]
        fn ignores_the_high_byte() {
            // GetPixel leaves it zero, but a COLORREF's top byte is not color
            // data and must never reach the string.
            assert_eq!(colorref_to_hex(0xff12_3456), "#563412");
        }
    }
}

#[cfg(not(windows))]
mod imp {
    const UNSUPPORTED: &str = "Native screen picking is only implemented on Windows.";

    pub fn color_at_cursor() -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn pick_blocking() -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub const SUPPORTED: bool = false;
}

/// Whether the native dropper works here. The web client probes this once and
/// falls back to the browser EyeDropper API when it is false.
#[tauri::command]
pub fn dropper_supported() -> bool {
    imp::SUPPORTED
}

/// The color directly under the cursor, for the live readout while picking.
/// Cheap enough to poll: one GDI read, no capture.
#[tauri::command]
pub fn dropper_color_at_cursor() -> Result<String, String> {
    imp::color_at_cursor()
}

/// Sample one pixel, chosen by the user's next click. `None` means they cancelled
/// with Escape or a right click.
///
/// `spawn_blocking` keeps the wait off both the UI thread and the async runtime's
/// workers — it parks for as long as the user takes to aim.
#[tauri::command]
pub async fn dropper_pick() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(imp::pick_blocking)
        .await
        .map_err(|e| format!("Screen pick failed to start: {e}"))?
}
