import type { SnapZone, WindowPlacement } from "./session";

// Which zone, never how wide: snapped geometry is CSS (`win--left`,
// `win--max`); only free windows carry pixel positions.

export interface DeskRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const SNAP_EDGE = 48;
export const SNAP_CORNER = 110;

/** Below this the desk is mid-animation (see `isDeskMeasurable`). */
const DESK_MIN_W = 240;
const DESK_MIN_H = 160;

/**
 * `hi` is floored at `lo`: callers compute it by subtraction, which goes
 * negative for a window wider than the desk.
 */
export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Corners first, with a wider box, or the edges would claim them. Top edge
 * maximizes, sides take halves. No bottom zone: the dock is there.
 */
export function snapZoneForDrag(point: Point, desk: DeskRect): SnapZone | null {
  const nearL = point.x - desk.left < SNAP_CORNER;
  const nearR = desk.right - point.x < SNAP_CORNER;
  const nearT = point.y - desk.top < SNAP_CORNER;
  const nearB = desk.bottom - point.y < SNAP_CORNER;

  if (nearL && nearT) return "top-left";
  if (nearR && nearT) return "top-right";
  if (nearL && nearB) return "bottom-left";
  if (nearR && nearB) return "bottom-right";
  if (point.y - desk.top < SNAP_EDGE) return "max";
  if (point.x - desk.left < SNAP_EDGE) return "left";
  if (desk.right - point.x < SNAP_EDGE) return "right";
  return null;
}

/**
 * Unlike `snapZoneForDrag`: fractions of the desk, never null (the middle is
 * "centred"), and never `max`.
 */
export function dropZoneForCard(point: Point, desk: DeskRect): SnapZone {
  const fx = (point.x - desk.left) / desk.width;
  const fy = (point.y - desk.top) / desk.height;

  if (fx < 0.3) {
    if (fy < 0.33) return "top-left";
    return fy > 0.67 ? "bottom-left" : "left";
  }
  if (fx > 0.7) {
    if (fy < 0.33) return "top-right";
    return fy > 0.67 ? "bottom-right" : "right";
  }
  return "center";
}

/**
 * The chat column collapse animates the desk to a few pixels for a frame;
 * clamping then would pile every window top-left permanently.
 */
export const isDeskMeasurable = (desk: { width: number; height: number }) =>
  desk.width >= DESK_MIN_W && desk.height >= DESK_MIN_H;

/** Returns the same object when unchanged. Snapped windows are untouched. */
export function clampToDesk(
  win: WindowPlacement,
  desk: { width: number; height: number },
): WindowPlacement {
  if (win.zone !== null) return win;
  const x = clamp(win.x, 0, desk.width - win.w);
  const y = clamp(win.y, 0, desk.height - win.h);
  return x === win.x && y === win.y ? win : { ...win, x, y };
}

/** Preserves identity when unchanged, so the ResizeObserver doesn't loop. */
export function clampAllToDesk(
  windows: WindowPlacement[],
  desk: { width: number; height: number },
): WindowPlacement[] {
  let changed = false;
  const next = windows.map((w) => {
    const moved = clampToDesk(w, desk);
    if (moved !== w) changed = true;
    return moved;
  });
  return changed ? next : windows;
}
