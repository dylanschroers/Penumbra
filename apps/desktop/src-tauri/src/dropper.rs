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
// Windows-only for now. Everything else falls back to the EyeDropper path in
// the web client (apps/web/src/color/screenDropper.ts), which is why the
// commands report support rather than failing to exist.
//
// Support is reported as two flags, not one, because the platforms differ in
// *which half* they can do. Windows needs the whole interaction built by hand —
// the mouse hook below is most of this file — and having built it, sampling the
// cursor mid-pick is free. The intended Linux and macOS backends are the
// opposite: the XDG desktop portal's `org.freedesktop.portal.Screenshot.
// PickColor` and `NSColorSampler` each run the entire pick themselves, magnifier
// and all, and hand back one color at the end. That is far less code, but it
// leaves nothing to poll. So `pick` and `live_sample` are independent, and the
// client hides its live readout rather than calling a command that cannot answer.

use serde_json::{json, Value};

/// Format an RGB triple as CSS `#rrggbb`.
///
/// The common currency between backends: every one of them ends here, so this is
/// the single place the output format is decided.
///
/// Windows reaches it through `colorref_to_hex` and Linux calls it directly.
/// On the platforms still waiting for a backend only the tests call it, which is
/// the intended state rather than a warning worth carrying — it is tested
/// everywhere precisely so it is already correct when NSColorSampler arrives.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn rgb_to_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// One 0.0–1.0 channel as a byte, for backends that report colors as floats
/// (the XDG portal, and NSColorSampler when it lands).
///
/// Rounded rather than truncated: `1.0 * 255.0` is exactly 255, but any value a
/// hair under it truncates a whole step low, so a pure white pick would come
/// back as #fefefe. Clamped first because nothing obliges a portal to stay in
/// range, and `as u8` saturates an out-of-range float silently.
///
/// Up here with `rgb_to_hex` for the same reason: it is pure arithmetic, its
/// failure mode is an off-by-one nobody would notice by eye, and inside a
/// platform-gated module its tests would compile nowhere else.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn channel_to_byte(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Format a Win32 COLORREF as CSS `#rrggbb`.
///
/// The one place this is easy to get silently wrong: COLORREF is `0x00bbggrr`,
/// so the byte order is the reverse of the hex string. Reading it as RGB yields
/// a plausible-looking color that is simply the wrong one.
///
/// Deliberately outside the Windows `imp` below, even though only Windows calls
/// it. It is pure integer math with no Win32 in it, and while it lived inside a
/// `#[cfg(windows)]` module its tests compiled nowhere else — `cargo test` on
/// Linux reported "0 passed" while the byte order it guards went unchecked.
///
/// Only the Windows `imp` calls it, so off Windows the tests are its only
/// caller — see `rgb_to_hex` above.
#[cfg_attr(not(windows), allow(dead_code))]
fn colorref_to_hex(raw: u32) -> String {
    rgb_to_hex(
        (raw & 0xff) as u8,
        ((raw >> 8) & 0xff) as u8,
        ((raw >> 16) & 0xff) as u8,
    )
}

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

    use super::colorref_to_hex;

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

    /// `spawn_blocking` keeps the wait off both the UI thread and the async
    /// runtime's workers — `pick_blocking` parks for as long as the user takes
    /// to aim. The portal backend needs no such thing, which is why the async
    /// boundary sits per-platform rather than in the command.
    pub async fn pick() -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(pick_blocking)
            .await
            .map_err(|e| format!("Screen pick failed to start: {e}"))?
    }

    pub const CAN_PICK: bool = true;
    /// Free here: the hook already runs on its own thread, so the UI thread is
    /// idle during a pick and one extra GetPixel per poll costs nothing.
    pub const CAN_LIVE_SAMPLE: bool = true;
}

/// Linux: the XDG desktop portal picks the color for us.
///
/// `org.freedesktop.portal.Screenshot.PickColor` hands the whole interaction to
/// the compositor — magnifier, click, Escape — and returns one color. That is
/// why this module is twenty lines against Windows' two hundred: everything the
/// mouse hook above exists to do, the portal already did.
///
/// It also works on X11, not just Wayland, because the portal is the frontend in
/// both cases. What it cannot do is sample mid-pick: it owns the interaction and
/// exposes nothing until the user commits, hence `CAN_LIVE_SAMPLE = false`.
#[cfg(target_os = "linux")]
mod imp {
    use ashpd::desktop::{Color, ResponseError};

    use super::{channel_to_byte as channel, rgb_to_hex};

    pub async fn pick() -> Result<Option<String>, String> {
        match Color::pick().send().await.and_then(|req| req.response()) {
            Ok(c) => Ok(Some(rgb_to_hex(
                channel(c.red()),
                channel(c.green()),
                channel(c.blue()),
            ))),
            // Backing out is ordinary flow, the same as a right click on
            // Windows — `None`, not an error.
            Err(ashpd::Error::Response(ResponseError::Cancelled)) => Ok(None),
            // Everything else is worth showing: no portal frontend installed, a
            // backend without Screenshot v2, or a refused permission all land
            // here and are all things the user can act on.
            Err(e) => Err(format!("Screen pick failed: {e}")),
        }
    }

    pub fn color_at_cursor() -> Result<String, String> {
        Err("The desktop portal does not expose the color under the cursor.".into())
    }

    pub const CAN_PICK: bool = true;
    pub const CAN_LIVE_SAMPLE: bool = false;
}

/// macOS and anything else: no native backend yet.
///
/// The macOS one is `NSColorSampler` (10.15+), which behaves like the portal —
/// it runs its own magnifier and returns a single color — so it will land as
/// `CAN_PICK` alone, the same shape as Linux.
#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    const UNSUPPORTED: &str = "Native screen picking is not implemented on this platform yet.";

    pub fn color_at_cursor() -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }

    pub async fn pick() -> Result<Option<String>, String> {
        Err(UNSUPPORTED.into())
    }

    pub const CAN_PICK: bool = false;
    pub const CAN_LIVE_SAMPLE: bool = false;
}

/// What the native dropper can do here.
///
/// Two independent flags — see the note at the top of this file. The web client
/// probes this once: `pick` false sends it to the browser EyeDropper API, and
/// `liveSample` false makes it drop the readout while keeping the pick.
///
/// Hand-built rather than a derived Serialize, matching db.rs and fs.rs: this
/// crate carries `serde_json` but no serde derive, and one two-field object is
/// not the thing to change that for.
#[tauri::command]
pub fn dropper_capabilities() -> Value {
    json!({ "pick": imp::CAN_PICK, "liveSample": imp::CAN_LIVE_SAMPLE })
}

#[cfg(test)]
mod tests {
    use super::{channel_to_byte, colorref_to_hex, rgb_to_hex};

    // These run on every platform now. They used to sit inside the Windows-only
    // module, where `cargo test` on Linux found them and reported "0 passed" —
    // three green-looking tests that had never executed.

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

    #[test]
    fn formats_rgb_in_source_order() {
        // The backend-neutral entry point: a portal or NSColorSampler hands over
        // channels already in RGB, so this must *not* reverse them the way the
        // COLORREF path does.
        assert_eq!(rgb_to_hex(0xff, 0x00, 0x00), "#ff0000");
        assert_eq!(rgb_to_hex(0x01, 0x02, 0x03), "#010203");
    }

    #[test]
    fn scales_a_portal_channel_to_a_full_byte() {
        // Truncating instead of rounding is the bug worth naming: it puts the
        // top of the range a step low, so a pure white pick reads #fefefe and
        // nobody notices until they compare two swatches.
        assert_eq!(channel_to_byte(1.0), 255);
        assert_eq!(channel_to_byte(0.999_999), 255);
        assert_eq!(channel_to_byte(0.0), 0);
        assert_eq!(channel_to_byte(0.5), 128);
    }

    #[test]
    fn clamps_a_channel_the_portal_had_no_business_sending() {
        // `as u8` saturates rather than wrapping, but only after the multiply —
        // clamping first is what keeps a NaN-adjacent value from being read as
        // a color at all.
        assert_eq!(channel_to_byte(1.5), 255);
        assert_eq!(channel_to_byte(-0.2), 0);
    }
}

/// The color directly under the cursor, for the live readout while picking.
///
/// Only meaningful where `dropper_capabilities` reported `liveSample`; the
/// client does not call it otherwise. On Windows it is one GDI read, no capture,
/// and cheap enough to poll.
#[tauri::command]
pub fn dropper_color_at_cursor() -> Result<String, String> {
    imp::color_at_cursor()
}

/// Sample one pixel, chosen by the user's next click. `None` means they
/// cancelled — Escape or a right click on Windows, the portal's own dismissal
/// on Linux.
///
/// Each backend owns its own threading: Windows parks a blocking wait on a
/// dedicated thread, while the portal is natively async. Putting that inside
/// `imp` rather than here is what keeps this command one line on both.
#[tauri::command]
pub async fn dropper_pick() -> Result<Option<String>, String> {
    imp::pick().await
}
