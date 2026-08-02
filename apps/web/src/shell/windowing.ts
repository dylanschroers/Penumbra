import type { SnapZone, WindowPlacement } from "./session";

// Desk geometry for the workspace's windows: where a drag snaps to, and how a
// free window is kept inside the desk.
//
// Pulled out of AppShell because every rule here is a threshold comparison, and
// every way one can be wrong is quiet — a corner that snaps to an edge, a
// window pinned to the wrong side, a release that strands a card past the desk.
// None of it throws and none of it shows up in a screenshot of the ordinary
// case, which is exactly the shape of thing worth pinning in tests.
//
// The rendering side is deliberately not here: a snapped window's geometry is
// CSS (`win--left`, `win--max`, …), and only free windows carry inline pixel
// positions. So this decides *which zone*, never how wide the halves are.

/** The parts of a DOMRect these functions read. */
export interface DeskRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** A pointer position in viewport coordinates (`clientX`/`clientY`). */
export interface Point {
  x: number;
  y: number;
}

/** Width (px) of the desk-edge hot zones that snap a dragged window, and the
 *  larger corner boxes that snap it to a quarter. */
export const SNAP_EDGE = 48;
export const SNAP_CORNER = 110;

/** Below this the desk is mid-animation rather than genuinely small — see
 *  `isDeskMeasurable`. */
const DESK_MIN_W = 240;
const DESK_MIN_H = 160;

/**
 * Clamp `v` into `[lo, hi]`.
 *
 * `hi` is floored at `lo` because the callers derive it by subtraction
 * (`deskWidth - windowWidth`), which goes negative for a window wider than the
 * desk. Without the floor that inverts the range and `Math.min` would pull the
 * window to a negative coordinate — off the top-left, out of reach of its own
 * title bar.
 */
export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * The zone a window dragged by its bar would snap to, or `null` to leave it
 * floating where it was dropped.
 *
 * Corners are tested first and with a wider box (`SNAP_CORNER`): they sit
 * inside the two edges they touch, so an edge test running first would claim
 * every corner and the quarters would be unreachable. After that the top edge
 * maximizes and the sides take halves — the Windows arrangement.
 *
 * Note there is no bottom-edge zone: the dock lives there, and a window snapped
 * against it would be half behind the tray.
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
 * The zone a *dock card* dragged onto the desk would open in.
 *
 * Deliberately a different rule from `snapZoneForDrag`, and the difference is
 * worth stating because the two produce the same `SnapZone` type:
 *
 *   - Fractions of the desk, not pixels from its edge. A card is dropped by
 *     aiming at a region rather than by nudging a window it is already holding,
 *     so the target should scale with the desk instead of staying 48px wide.
 *   - Never `null`. A drop has to put the window *somewhere*; the middle band
 *     means "centred", where a bar drag there means "leave it alone".
 *   - No `max`. Dragging a card to the top opens it top-left or centred, never
 *     maximized, so the gesture cannot swallow the whole desk by accident.
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
 * Whether the desk is big enough to clamp windows against.
 *
 * The chat column collapses by animating a grid track to `0fr`, so mid-collapse
 * the desk reports a few pixels wide for a frame or two. Clamping against that
 * would pile every window into the top-left corner and they would stay there
 * once it finished — a permanent result from a transient measurement.
 */
export const isDeskMeasurable = (desk: { width: number; height: number }) =>
  desk.width >= DESK_MIN_W && desk.height >= DESK_MIN_H;

/**
 * Pull a free window back inside the desk.
 *
 * Returns the same object when nothing moved, so callers can skip a state
 * update; snapped windows (`zone !== null`) are returned untouched because CSS
 * places them and their stored x/y are stale by design.
 */
export function clampToDesk(
  win: WindowPlacement,
  desk: { width: number; height: number },
): WindowPlacement {
  if (win.zone !== null) return win;
  const x = clamp(win.x, 0, desk.width - win.w);
  const y = clamp(win.y, 0, desk.height - win.h);
  return x === win.x && y === win.y ? win : { ...win, x, y };
}

/**
 * `clampToDesk` across a list, preserving identity when nothing moved.
 *
 * The identity check is what keeps a ResizeObserver from looping: returning a
 * fresh array every observation would set state on every frame of an animating
 * desk, which re-renders, which the observer sees again.
 */
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
