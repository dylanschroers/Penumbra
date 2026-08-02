// Screen-wide color sampling for the color picker.
//
// Two backends, because neither covers everything:
//
//   native      The desktop shell's dropper (apps/desktop/src-tauri/src/
//               dropper.rs). Today that is Windows' GDI path: one pixel per
//               sample, with the pick click swallowed by a mouse hook.
//   eyedropper  The browser EyeDropper API. Works in any Chromium (including
//               the plain-web build), but drags a magnifier overlay that
//               continuously captures the screen — noticeably laggy across
//               several monitors, which is why native is preferred.
//
// Both sample the composited desktop, so either way this reads pixels from other
// applications on any monitor, not just from our own window.
//
// Picking and *live sampling* are reported separately, because they are not the
// same capability. EyeDropper draws its own magnifier and exposes nothing to
// poll; the Linux and macOS native backends (the XDG portal, NSColorSampler)
// will be the same way, since each runs the whole pick itself. Only the Windows
// path, which had to build the interaction by hand, can also answer "what is
// under the cursor right now". So a caller asks for the readout and is told no,
// rather than inferring it from which backend won.

import { invoke } from "@tauri-apps/api/core";

interface EyeDropperResult {
  /** The picked color as `#rrggbb`, always sRGB and fully opaque. */
  sRGBHex: string;
}

interface EyeDropperInstance {
  open(options?: { signal?: AbortSignal }): Promise<EyeDropperResult>;
}

type EyeDropperCtor = new () => EyeDropperInstance;

declare global {
  interface Window {
    EyeDropper?: EyeDropperCtor;
  }
}

export type DropperBackend = "native" | "eyedropper" | "none";

export interface DropperSupport {
  /** Which backend a pick will go through; `none` means picking is unavailable. */
  backend: DropperBackend;
  /** Whether `colorAtCursor` can report anything during a pick. Never true
   *  unless `backend` is `native`, but not implied by it. */
  liveSample: boolean;
}

/** What the desktop shell reports (`dropper_capabilities` in dropper.rs). */
interface NativeCapabilities {
  pick: boolean;
  liveSample: boolean;
}

// Injected into every Tauri v2 webview; absent in ordinary browsers. Mirrors the
// probe in src/db/client.ts and src/fs/fsClient.ts.
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const hasEyeDropper = () =>
  typeof window !== "undefined" && typeof window.EyeDropper === "function";

/** Whatever the webview itself offers, once the shell has declined or is absent. */
const webBackend = (): DropperSupport =>
  hasEyeDropper()
    ? { backend: "eyedropper", liveSample: false }
    : { backend: "none", liveSample: false };

async function detectSupport(): Promise<DropperSupport> {
  if (isTauri) {
    try {
      const caps = await invoke<NativeCapabilities>("dropper_capabilities");
      if (caps.pick) {
        return { backend: "native", liveSample: caps.liveSample === true };
      }
    } catch {
      // A shell without the command — either older than the dropper, or older
      // than this capability split. Either way, fall through to the webview.
    }
  }
  return webBackend();
}

let cached: Promise<DropperSupport> | null = null;

/** What this build can do. Probed once, then reused. */
export function dropperSupport(): Promise<DropperSupport> {
  cached ??= detectSupport();
  return cached;
}

async function openEyeDropper(signal?: AbortSignal): Promise<string | null> {
  const EyeDropperImpl = window.EyeDropper;
  if (typeof EyeDropperImpl !== "function") {
    throw new Error("Screen color picking is not supported here.");
  }
  try {
    const { sRGBHex } = await new EyeDropperImpl().open(
      signal ? { signal } : undefined,
    );
    return sRGBHex;
  } catch (err) {
    // Escape (and an aborted signal) surface as AbortError; treat as a cancel.
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/**
 * Open the dropper for a single pick.
 *
 * Resolves with the picked `#rrggbb`, or `null` if the user cancelled — a cancel
 * is normal flow, not an error, so it isn't thrown. Cancelling is Escape on
 * either backend, and additionally a right click on the native one.
 *
 * `signal` applies to the EyeDropper backend only; the native pick is ended by
 * the OS-level hook, which JS has no handle on. Must be called from a user
 * gesture — EyeDropper requires transient activation.
 */
export async function pickScreenColor(
  signal?: AbortSignal,
): Promise<string | null> {
  const { backend } = await dropperSupport();
  if (backend === "native") {
    return await invoke<string | null>("dropper_pick");
  }
  if (backend === "eyedropper") return await openEyeDropper(signal);
  throw new Error("Screen color picking is not supported here.");
}

/**
 * The color under the cursor right now, for a live readout while picking.
 *
 * Only where the backend reports `liveSample` — there it is one cheap pixel
 * read, safe to poll. Everywhere else the picker owns its own magnifier and
 * exposes nothing to sample, so this returns `null` rather than pretending, and
 * callers should hide the readout instead of polling for a value that will not
 * come.
 */
export async function colorAtCursor(): Promise<string | null> {
  if (!(await dropperSupport()).liveSample) return null;
  return await invoke<string>("dropper_color_at_cursor");
}
