import { describe, expect, it } from "vitest";
import type { WindowPlacement } from "./session";
import {
  clamp,
  clampAllToDesk,
  clampToDesk,
  type DeskRect,
  dropZoneForCard,
  isDeskMeasurable,
  SNAP_CORNER,
  SNAP_EDGE,
  snapZoneForDrag,
} from "./windowing";

// Two zone resolvers that return the same type by different rules, and a clamp
// whose bounds are computed by subtraction and can invert. All three fail
// quietly — a window lands somewhere slightly wrong and nothing throws — so
// the boundaries are pinned here rather than left to be noticed in use.

/** A 1000×600 desk offset from the viewport origin, so a test that confused
 *  client coordinates with desk-relative ones fails instead of coinciding. */
const desk: DeskRect = {
  left: 100,
  top: 50,
  right: 1100,
  bottom: 650,
  width: 1000,
  height: 600,
};

/** Desk-relative → viewport, matching what a pointer event would carry. */
const at = (x: number, y: number) => ({ x: desk.left + x, y: desk.top + y });

const win = (over: Partial<WindowPlacement> = {}): WindowPlacement => ({
  id: "tasks",
  zone: null,
  x: 10,
  y: 10,
  w: 400,
  h: 300,
  ...over,
});

describe("clamp", () => {
  it("holds a value inside its bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it("pins to the low bound when the range is inverted", () => {
    // What a window wider than the desk produces: hi = deskWidth - winWidth is
    // negative. Without the floor this would return that negative number and
    // park the window off the top-left, title bar and all.
    expect(clamp(20, 0, -150)).toBe(0);
  });
});

describe("snapZoneForDrag", () => {
  it("leaves a window floating in the middle of the desk", () => {
    expect(snapZoneForDrag(at(500, 300), desk)).toBeNull();
  });

  it("maximizes from the top edge and halves from the sides", () => {
    expect(snapZoneForDrag(at(500, SNAP_EDGE - 1), desk)).toBe("max");
    expect(snapZoneForDrag(at(SNAP_EDGE - 1, 300), desk)).toBe("left");
    expect(snapZoneForDrag(at(desk.width - SNAP_EDGE + 1, 300), desk)).toBe(
      "right",
    );
  });

  it("gives corners the wider box, so quarters stay reachable", () => {
    // Inside SNAP_CORNER but outside SNAP_EDGE on both axes: an edge-first rule
    // would call this "max" and no quarter would ever be selectable.
    const between = SNAP_CORNER - 1;
    expect(between).toBeGreaterThan(SNAP_EDGE);
    expect(snapZoneForDrag(at(between, between), desk)).toBe("top-left");
    expect(snapZoneForDrag(at(desk.width - between, between), desk)).toBe(
      "top-right",
    );
    expect(snapZoneForDrag(at(between, desk.height - between), desk)).toBe(
      "bottom-left",
    );
    expect(
      snapZoneForDrag(at(desk.width - between, desk.height - between), desk),
    ).toBe("bottom-right");
  });

  it("has no bottom edge zone, because the dock is there", () => {
    // Deep at the bottom but horizontally central: no corner claims it and
    // there is no "bottom" half, so it stays free.
    expect(snapZoneForDrag(at(500, desk.height - 1), desk)).toBeNull();
  });

  it("treats the thresholds as strict, so the boundary pixel stays out", () => {
    expect(snapZoneForDrag(at(SNAP_EDGE, 300), desk)).toBeNull();
    expect(snapZoneForDrag(at(SNAP_CORNER, SNAP_CORNER), desk)).toBeNull();
  });
});

describe("dropZoneForCard", () => {
  it("opens a card dropped in the middle band centred", () => {
    expect(dropZoneForCard(at(500, 300), desk)).toBe("center");
  });

  it("splits each side into two quarters around a half-height band", () => {
    expect(dropZoneForCard(at(100, 300), desk)).toBe("left");
    expect(dropZoneForCard(at(100, 60), desk)).toBe("top-left");
    expect(dropZoneForCard(at(100, 540), desk)).toBe("bottom-left");
    expect(dropZoneForCard(at(900, 300), desk)).toBe("right");
    expect(dropZoneForCard(at(900, 60), desk)).toBe("top-right");
    expect(dropZoneForCard(at(900, 540), desk)).toBe("bottom-right");
  });

  it("never maximizes, unlike a bar drag to the same place", () => {
    // The gesture that maximizes a window must not be reachable by dropping a
    // card, or a card aimed at the top of the desk swallows the whole thing.
    const topMiddle = at(500, 2);
    expect(snapZoneForDrag(topMiddle, desk)).toBe("max");
    expect(dropZoneForCard(topMiddle, desk)).toBe("center");
  });

  it("scales with the desk rather than using fixed pixels", () => {
    // 100px in is "left" on a 1000px desk and "centre" on a 200px one; that is
    // the whole difference from snapZoneForDrag's fixed hot zones.
    const narrow: DeskRect = { ...desk, right: desk.left + 200, width: 200 };
    expect(dropZoneForCard(at(100, 300), desk)).toBe("left");
    expect(dropZoneForCard(at(100, 300), narrow)).toBe("center");
  });

  it("always answers, so a drop always lands somewhere", () => {
    for (const p of [at(0, 0), at(1000, 600), at(500, 300), at(0, 600)]) {
      expect(dropZoneForCard(p, desk)).not.toBeNull();
    }
  });
});

describe("isDeskMeasurable", () => {
  it("accepts a desk at its working size", () => {
    expect(isDeskMeasurable({ width: 1000, height: 600 })).toBe(true);
  });

  it("rejects the sliver a collapsing chat column leaves mid-animation", () => {
    expect(isDeskMeasurable({ width: 12, height: 600 })).toBe(false);
    expect(isDeskMeasurable({ width: 1000, height: 40 })).toBe(false);
  });
});

describe("clampToDesk", () => {
  it("pulls a stranded window back inside", () => {
    const moved = clampToDesk(win({ x: 900, y: 500 }), desk);
    expect(moved).toMatchObject({ x: 600, y: 300 });
  });

  it("returns the same object when nothing moved", () => {
    const w = win({ x: 10, y: 10 });
    expect(clampToDesk(w, desk)).toBe(w);
  });

  it("leaves a snapped window alone", () => {
    // Its x/y are stale by design — CSS places it — so "correcting" them would
    // write nonsense that takes effect the moment it is dragged free.
    const w = win({ zone: "left", x: 9999, y: 9999 });
    expect(clampToDesk(w, desk)).toBe(w);
  });

  it("keeps a window larger than the desk reachable", () => {
    const moved = clampToDesk(win({ x: 50, y: 40, w: 1400, h: 900 }), desk);
    expect(moved).toMatchObject({ x: 0, y: 0 });
  });
});

describe("clampAllToDesk", () => {
  it("preserves array identity when no window moved", () => {
    // A fresh array every observation would set state on every frame of an
    // animating desk, which re-renders, which the ResizeObserver sees again.
    const list = [win({ x: 0, y: 0 }), win({ id: "notes", x: 20, y: 20 })];
    expect(clampAllToDesk(list, desk)).toBe(list);
  });

  it("returns a new array once something moved, keeping the rest identical", () => {
    const still = win({ id: "notes", x: 20, y: 20 });
    const list = [win({ x: 900, y: 500 }), still];
    const next = clampAllToDesk(list, desk);
    expect(next).not.toBe(list);
    expect(next[0]).toMatchObject({ x: 600, y: 300 });
    expect(next[1]).toBe(still);
  });
});
