// Open modules and window placements, under one key so they can't drift
// apart.

import { STORAGE_NAMESPACE } from "@penumbra/shared";

export const SESSION_KEY = `${STORAGE_NAMESPACE}.shell.session.v1`;

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

/** Rect fields are unused while snapped. */
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
 * Ids are checked against the registry: a dropped module would otherwise come
 * back as a dock card getModule can't resolve.
 */
export function loadSession(allowedIds: readonly string[]): ShellSession {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    const open: string[] = Array.isArray(parsed?.open)
      ? parsed.open.filter(
          (id: unknown) => typeof id === "string" && allowedIds.includes(id),
        )
      : [];

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
        windows.push({ id, zone: "center", x: 0, y: 0, w: 0, h: 0 });
      }
    }

    // v1 stored a single `focused` id; reopen it centred.
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
    return EMPTY;
  }
}

/** Silent on failure. */
export function saveSession(session: ShellSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}
}
