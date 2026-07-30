// Screen-wide color sampling for the color picker.
//
// Two backends, because neither covers everything:
//
//   native      The desktop shell's GDI dropper (apps/desktop/src-tauri/src/
//               dropper.rs). Reads a single pixel per sample and swallows the
//               pick click with a mouse hook. Windows only.
//   eyedropper  The browser EyeDropper API. Works in any Chromium (including
//               the plain-web build), but drags a magnifier overlay that
//               continuously captures the screen — noticeably laggy across
//               several monitors, which is why native is preferred.
//
// Both sample the composited desktop, so either way this reads pixels from other
// applications on any monitor, not just from our own window.

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

// Injected into every Tauri v2 webview; absent in ordinary browsers. Mirrors the
// probe in src/db/client.ts and src/fs/fsClient.ts.
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const hasEyeDropper = () =>
  typeof window !== "undefined" && typeof window.EyeDropper === "function";

async function detectBackend(): Promise<DropperBackend> {
  if (isTauri) {
    try {
      if (await invoke<boolean>("dropper_supported")) return "native";
    } catch {
      // An older shell without the command, or a non-Windows desktop build.
      // Fall through to whatever the webview itself offers.
    }
  }
  return hasEyeDropper() ? "eyedropper" : "none";
}

let cached: Promise<DropperBackend> | null = null;

/** Which backend this build will use. Probed once, then reused. */
export function dropperBackend(): Promise<DropperBackend> {
  cached ??= detectBackend();
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
  const backend = await dropperBackend();
  if (backend === "native") {
    return await invoke<string | null>("dropper_pick");
  }
  if (backend === "eyedropper") return await openEyeDropper(signal);
  throw new Error("Screen color picking is not supported here.");
}

/**
 * The color under the cursor right now, for a live readout while picking.
 *
 * Native backend only: it is one cheap pixel read, safe to poll. The EyeDropper
 * backend draws its own magnifier and exposes nothing to sample, so this returns
 * `null` there rather than pretending.
 */
export async function colorAtCursor(): Promise<string | null> {
  if ((await dropperBackend()) !== "native") return null;
  return await invoke<string>("dropper_color_at_cursor");
}
