// Shared workspace grid metrics. Module positions/sizes (ModuleInstance) are in
// these column/row units; react-grid-layout maps them to pixels from the live
// container width. Both the canvas (Workspace) and the placement logic (useLayout)
// read these, so they live here to stay in sync.
export const COLS = 24;
export const ROW_HEIGHT = 40;
export const MARGIN: [number, number] = [12, 12];

/** A rectangle in grid units. ModuleInstance is assignable to it. */
export type Rect = { x: number; y: number; w: number; h: number };

/** Whether two grid rectangles share any area. Edge-touching is not overlap. */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

// First free grid slot scanning left-to-right within a row, then top-to-bottom.
// New tiles fill gaps and wrap to the next row instead of always extending the
// page downward. Terminates: once y clears every existing tile, row 0..COLS-w is
// empty, so a slot always exists. Pure placement math — kept out of useLayout so
// it can be unit-tested without React.
export function firstFreeSlot(existing: Rect[], w: number, h: number): Rect {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= COLS; x++) {
      const candidate = { x, y, w, h };
      if (!existing.some((tile) => overlaps(candidate, tile))) return candidate;
    }
  }
}
