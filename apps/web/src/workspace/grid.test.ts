import { describe, it, expect } from "vitest";
import { COLS, firstFreeSlot, overlaps } from "./grid";

describe("overlaps", () => {
  it("detects shared area", () => {
    expect(overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 })).toBe(
      true,
    );
  });

  it("treats edge-touching tiles as non-overlapping", () => {
    // {0..2} and {2..4} share only the boundary line, not area.
    expect(overlaps({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(
      false,
    );
  });
});

describe("firstFreeSlot", () => {
  it("places the first tile at the origin", () => {
    expect(firstFreeSlot([], 8, 6)).toEqual({ x: 0, y: 0, w: 8, h: 6 });
  });

  it("fills a gap in the same row before extending downward", () => {
    const existing = [{ x: 0, y: 0, w: 8, h: 6 }];
    expect(firstFreeSlot(existing, 8, 6)).toEqual({ x: 8, y: 0, w: 8, h: 6 });
  });

  it("wraps to the next row when the current row is full", () => {
    // Three 8-wide tiles fill all 24 columns of row 0.
    const full = [
      { x: 0, y: 0, w: 8, h: 1 },
      { x: 8, y: 0, w: 8, h: 1 },
      { x: 16, y: 0, w: 8, h: 1 },
    ];
    expect(firstFreeSlot(full, 8, 1)).toEqual({ x: 0, y: 1, w: 8, h: 1 });
  });

  it("wraps when a wide tile can't fit the row's remaining space", () => {
    // 20 columns used; an 8-wide tile has no room in row 0 (would need x≥20 but
    // x can be at most COLS-8=16), so it drops to the next row.
    const existing = [{ x: 0, y: 0, w: 20, h: 1 }];
    expect(firstFreeSlot(existing, 8, 1)).toEqual({ x: 0, y: 1, w: 8, h: 1 });
  });

  it("never returns a slot that would exceed the column count", () => {
    const slot = firstFreeSlot([], COLS, 2);
    expect(slot.x + slot.w).toBeLessThanOrEqual(COLS);
  });
});
