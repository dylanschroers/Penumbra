// What the shell reopens with: which modules are in the dock, and where each
// open window sits on the desk.
//
// The grid canvas persisted its layout, and nothing replaced that when the grid
// went — every reload came up with an empty dock and the user re-added the same
// modules by hand.
//
// Both fields live under one key because they are read and written together and
// two keys could drift apart: a window restored for a module that isn't open
// would leave the desk showing something the dock never mounted.

import { STORAGE_NAMESPACE } from "@penumbra/shared";

export const SESSION_KEY = `${STORAGE_NAMESPACE}.shell.session.v1`;

/** Where a snapped window sits on the desk: a half, a corner quarter,
 *  maximized, or centred. */
export type SnapZone =
  | "left"
  | "right"
  | "max"
  | "center"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const ZONES: readonly string[] = [
  "left",
  "right",
  "max",
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** One open window: a snap zone, or free-floating at a remembered rect
 *  (px, relative to the desk). The rect fields are unused while snapped. */
export interface WindowPlacement {
  id: string;
  zone: SnapZone | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShellSession {
  open: string[];
  windows: WindowPlacement[];
}

const EMPTY: ShellSession = { open: [], windows: [] };

function isFinite_(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read the stored session, keeping only what still makes sense.
 *
 * `allowedIds` is the registry's current dock-able set, and ids are checked
 * against it rather than trusted: a module since renamed or dropped would
 * otherwise come back as a dock card for something that no longer exists, and
 * `getModule` would return undefined for it every render thereafter.
 */
export function loadSession(allowedIds: readonly string[]): ShellSession {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    const open: string[] = Array.isArray(parsed?.open)
      ? parsed.open.filter(
          (id: unknown) => typeof id === "string" && allowedIds.includes(id),
        )
      : [];

    // A window has to name something in the open set — including after the
    // filter above, so a window whose module was dropped from the registry
    // doesn't survive as a pane over nothing.
    const windows: WindowPlacement[] = [];
    const raw: unknown[] = Array.isArray(parsed?.windows) ? parsed.windows : [];
    for (const entry of raw) {
      const rec = entry as Partial<WindowPlacement> | null;
      const id = rec?.id;
      if (typeof id !== "string" || !open.includes(id)) continue;
      if (windows.some((w) => w.id === id)) continue;
      const zone =
        typeof rec?.zone === "string" && ZONES.includes(rec.zone)
          ? (rec.zone as SnapZone)
          : null;
      if (zone !== null) {
        windows.push({ id, zone, x: 0, y: 0, w: 0, h: 0 });
      } else if (
        isFinite_(rec?.x) &&
        isFinite_(rec?.y) &&
        isFinite_(rec?.w) &&
        isFinite_(rec?.h) &&
        rec.w > 0 &&
        rec.h > 0
      ) {
        windows.push({
          id,
          zone: null,
          x: rec.x,
          y: rec.y,
          w: rec.w,
          h: rec.h,
        });
      } else {
        // A free placement without a usable rect falls back to centred.
        windows.push({ id, zone: "center", x: 0, y: 0, w: 0, h: 0 });
      }
    }

    // Legacy record: v1 stored a single `focused` id. Reopen it centred.
    if (
      windows.length === 0 &&
      typeof parsed?.focused === "string" &&
      open.includes(parsed.focused)
    ) {
      windows.push({
        id: parsed.focused,
        zone: "center",
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      });
    }

    return { open, windows };
  } catch {
    // Unavailable (SSR/tests) or corrupt — start empty, as the shell did before
    // it persisted anything.
    return EMPTY;
  }
}

/** Write the session back. Silent on failure: a workspace that doesn't survive
 *  the reload is worth less than one that takes the app down with it. */
export function saveSession(session: ShellSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Non-fatal.
  }
}
