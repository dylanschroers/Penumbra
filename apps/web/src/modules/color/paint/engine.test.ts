import { describe, expect, it } from "vitest";
import { type GestureOptions, PaintEngine, type Tool, WHITE } from "./engine";
import { HISTORY_BUDGET_BYTES } from "./history";
import { createRaster, hexToPixel } from "./raster";

const K = hexToPixel("#000000");
const R = hexToPixel("#ff0000");
const B = hexToPixel("#0000ff");
const OPTS: GestureOptions = { color: K, back: WHITE, size: 1, filled: false };

const engine = (w = 10, h = 10) => new PaintEngine(w, h);
const at = (e: PaintEngine, x: number, y: number) =>
  e.working.px[y * e.width + x];
const docAt = (e: PaintEngine, x: number, y: number) =>
  e.committed.px[y * e.width + x];

function drag(
  e: PaintEngine,
  tool: Tool,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: Partial<GestureOptions> = {},
) {
  e.begin(tool, x0, y0, { ...OPTS, ...opts });
  e.move(x1, y1);
  e.end();
}

describe("strokes", () => {
  it("does not touch the document until the gesture ends", () => {
    const e = engine();
    e.begin("pencil", 1, 1, OPTS);
    e.move(3, 1);
    expect(at(e, 2, 1)).toBe(K);
    expect(docAt(e, 2, 1)).toBe(WHITE);
    e.end();
    expect(docAt(e, 2, 1)).toBe(K);
  });

  it("makes one whole stroke one undo step", () => {
    const e = engine();
    e.begin("brush", 1, 1, OPTS);
    e.move(3, 1);
    e.move(3, 4);
    e.end();
    expect(e.history.undoCount).toBe(1);
    e.undo();
    expect(at(e, 3, 4)).toBe(WHITE);
    expect(at(e, 1, 1)).toBe(WHITE);
  });

  it("forces the pencil to one pixel whatever the brush size", () => {
    const e = engine();
    drag(e, "pencil", 5, 5, 5, 5, { size: 5 });
    expect(at(e, 5, 5)).toBe(K);
    expect(at(e, 6, 5)).toBe(WHITE);
  });

  it("erases with the back color, not with white", () => {
    const e = engine();
    drag(e, "brush", 0, 0, 9, 0);
    drag(e, "eraser", 0, 0, 4, 0, { back: R });
    expect(at(e, 2, 0)).toBe(R);
    expect(at(e, 8, 0)).toBe(K);
  });

  it("skips the undo record when a stroke changes nothing", () => {
    const e = engine();
    drag(e, "pencil", 1, 1, 4, 1, { color: WHITE });
    expect(e.history.undoCount).toBe(0);
    expect(e.revision).toBe(0);
  });
});

describe("shape previews", () => {
  it("leave no trail from earlier drag positions", () => {
    const e = engine();
    e.begin("rect", 1, 1, OPTS);
    e.move(8, 8);
    e.move(2, 2);
    e.end();
    expect(at(e, 8, 8)).toBe(WHITE);
    expect(at(e, 2, 2)).toBe(K);
    expect(e.history.undoCount).toBe(1);
  });

  it("preserve what was underneath", () => {
    const e = engine();
    drag(e, "brush", 0, 5, 9, 5, { color: R });
    e.begin("line", 0, 0, OPTS);
    e.move(9, 9);
    e.move(0, 1);
    e.end();
    expect(at(e, 4, 5)).toBe(R);
    expect(at(e, 0, 1)).toBe(K);
  });

  it("fill when asked", () => {
    const e = engine();
    drag(e, "rect", 1, 1, 5, 5, { filled: true });
    expect(at(e, 3, 3)).toBe(K);
    drag(e, "ellipse", 1, 1, 5, 5, { color: R, filled: false });
    expect(at(e, 3, 3)).toBe(K);
    expect(at(e, 3, 1)).toBe(R);
  });

  it("square up under shift", () => {
    const e = engine();
    e.begin("rect", 0, 0, OPTS);
    e.move(6, 2, true);
    e.end();
    expect(at(e, 6, 6)).toBe(K);
  });

  it("snap a line to 45 degrees under shift", () => {
    const e = engine();
    e.begin("line", 0, 0, OPTS);
    e.move(9, 1, true);
    e.end();
    expect(at(e, 9, 0)).toBe(K);
    expect(at(e, 9, 1)).toBe(WHITE);
  });

  it("back out on cancel", () => {
    const e = engine();
    e.begin("rect", 1, 1, OPTS);
    e.move(5, 5);
    e.cancel();
    expect(at(e, 1, 1)).toBe(WHITE);
    expect(e.busy).toBe(false);
    expect(e.history.canUndo).toBe(false);
  });
});

describe("fill", () => {
  it("commits straight away as one step", () => {
    const e = engine();
    e.begin("fill", 0, 0, { ...OPTS, color: R });
    expect(docAt(e, 9, 9)).toBe(R);
    expect(e.busy).toBe(false);
    e.undo();
    expect(at(e, 9, 9)).toBe(WHITE);
  });
});

describe("undo and redo", () => {
  it("walks back and forward through the same states", () => {
    const e = engine();
    drag(e, "pencil", 0, 0, 0, 0);
    drag(e, "pencil", 1, 0, 1, 0, { color: R });
    e.undo();
    expect([at(e, 0, 0), at(e, 1, 0)]).toEqual([K, WHITE]);
    e.undo();
    expect([at(e, 0, 0), at(e, 1, 0)]).toEqual([WHITE, WHITE]);
    e.redo();
    e.redo();
    expect([at(e, 0, 0), at(e, 1, 0)]).toEqual([K, R]);
    expect(docAt(e, 1, 0)).toBe(R);
  });

  it("drops the redo branch on a new edit", () => {
    const e = engine();
    drag(e, "pencil", 0, 0, 0, 0);
    e.undo();
    drag(e, "pencil", 1, 1, 1, 1);
    expect(e.history.canRedo).toBe(false);
  });

  it("ignores undo mid-gesture", () => {
    const e = engine();
    drag(e, "pencil", 0, 0, 0, 0);
    e.begin("pencil", 5, 5, OPTS);
    e.undo();
    e.end();
    expect(at(e, 0, 0)).toBe(K);
    expect(at(e, 5, 5)).toBe(K);
  });

  it("stores only the region a stroke touched", () => {
    const e = engine(100, 100);
    drag(e, "pencil", 10, 10, 12, 10);
    expect(e.history.usedBytes).toBe(3 * 4);
  });

  it("evicts the oldest edits past the budget but keeps the newest", () => {
    const e = engine(2048, 2048);
    const fullCanvasBytes = 2048 * 2048 * 4;
    for (let i = 0; i < 4; i++) {
      e.begin("fill", 0, 0, { ...OPTS, color: i % 2 ? R : B });
    }
    expect(e.history.usedBytes).toBeLessThanOrEqual(HISTORY_BUDGET_BYTES);
    expect(e.history.undoCount).toBe(
      Math.floor(HISTORY_BUDGET_BYTES / fullCanvasBytes),
    );
    expect(e.history.canUndo).toBe(true);
  });

  it("keeps one edit even when it alone is over budget", () => {
    const e = engine(1, 1);
    e.history.push({
      kind: "patch",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      pixels: new Uint32Array(HISTORY_BUDGET_BYTES / 4 + 1),
    });
    expect(e.history.undoCount).toBe(1);
  });
});

describe("selection", () => {
  function selected() {
    const e = engine();
    drag(e, "brush", 2, 2, 3, 2, { color: R });
    drag(e, "select", 2, 2, 3, 2);
    return e;
  }

  it("marks a marquee without changing the document", () => {
    const e = selected();
    expect(e.selection?.rect).toEqual({ x: 2, y: 2, w: 2, h: 1 });
    expect(e.history.undoCount).toBe(1);
  });

  it("clears on a plain click instead of selecting one pixel", () => {
    const e = selected();
    drag(e, "select", 8, 8, 8, 8);
    expect(e.selection).toBeNull();
  });

  it("clamps a marquee dragged past the canvas", () => {
    const e = engine();
    drag(e, "select", 5, 5, 99, -4);
    expect(e.selection?.rect).toEqual({ x: 5, y: 0, w: 5, h: 6 });
  });

  it("moves pixels, leaves the back color, and lands as one step", () => {
    const e = selected();
    drag(e, "select", 2, 2, 2, 6, { back: B });
    expect(at(e, 2, 6)).toBe(R);
    expect(at(e, 2, 2)).toBe(B);
    expect(docAt(e, 2, 6)).toBe(WHITE);
    e.commitSelection();
    expect(docAt(e, 2, 6)).toBe(R);
    expect(docAt(e, 2, 2)).toBe(B);
    expect(e.history.undoCount).toBe(2);
    e.undo();
    expect(at(e, 2, 2)).toBe(R);
    expect(at(e, 2, 6)).toBe(WHITE);
  });

  it("restores everything when a move is cancelled", () => {
    const e = selected();
    drag(e, "select", 2, 2, 2, 6);
    e.cancel();
    expect(at(e, 2, 2)).toBe(R);
    expect(at(e, 2, 6)).toBe(WHITE);
    expect(e.selection).toBeNull();
    expect(e.history.undoCount).toBe(1);
  });

  it("treats undo on a floating block as putting it back", () => {
    const e = selected();
    drag(e, "select", 2, 2, 2, 6);
    e.undo();
    expect(at(e, 2, 2)).toBe(R);
    expect(e.history.undoCount).toBe(1);
  });

  it("can hang off the canvas without wrapping, and clips on landing", () => {
    const e = selected();
    drag(e, "select", 2, 2, 9, 2);
    e.commitSelection();
    expect(docAt(e, 9, 2)).toBe(R);
    expect(docAt(e, 0, 3)).toBe(WHITE);
  });

  it("commits when another tool starts drawing", () => {
    const e = selected();
    drag(e, "select", 2, 2, 2, 6);
    drag(e, "pencil", 0, 0, 0, 0);
    expect(e.selection).toBeNull();
    expect(docAt(e, 2, 6)).toBe(R);
  });

  it("copies from the selection, or the canvas when there is none", () => {
    const e = selected();
    const block = e.copyBlock();
    expect([block.w, block.h, ...block.px]).toEqual([2, 1, R, R]);
    e.commitSelection();
    expect(e.copyBlock().px.length).toBe(100);
  });

  it("deletes to the back color as one step", () => {
    const e = selected();
    e.deleteSelection(B);
    expect(docAt(e, 2, 2)).toBe(B);
    expect(e.selection).toBeNull();
    e.undo();
    expect(docAt(e, 2, 2)).toBe(R);
  });

  it("pastes a floating block that only lands on commit", () => {
    const e = engine();
    e.paste({ w: 2, h: 1, px: new Uint32Array([R, R]) });
    expect(at(e, 1, 0)).toBe(R);
    expect(docAt(e, 1, 0)).toBe(WHITE);
    drag(e, "select", 0, 0, 5, 5);
    e.commitSelection();
    expect(docAt(e, 6, 5)).toBe(R);
    expect(docAt(e, 0, 0)).toBe(WHITE);
    expect(e.history.undoCount).toBe(1);
  });

  it("discards a pasted block on delete without an undo step", () => {
    const e = engine();
    e.paste({ w: 1, h: 1, px: new Uint32Array([R]) });
    e.deleteSelection(B);
    expect(at(e, 0, 0)).toBe(WHITE);
    expect(e.history.canUndo).toBe(false);
  });

  it("selects the whole canvas", () => {
    const e = engine();
    e.selectAll();
    expect(e.selection?.rect).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe("whole-canvas changes", () => {
  it("resizes from the top-left, filling new space with the back color", () => {
    const e = engine(2, 2);
    drag(e, "pencil", 1, 1, 1, 1);
    e.resize(3, 3, B);
    expect([e.width, e.height]).toEqual([3, 3]);
    expect(at(e, 1, 1)).toBe(K);
    expect(at(e, 2, 2)).toBe(B);
  });

  it("undoes and redoes a resize, dimensions included", () => {
    const e = engine(4, 4);
    drag(e, "pencil", 3, 3, 3, 3);
    e.resize(2, 2, WHITE);
    expect(e.working.px.length).toBe(4);
    e.undo();
    expect([e.width, e.height]).toEqual([4, 4]);
    expect(at(e, 3, 3)).toBe(K);
    e.redo();
    expect([e.width, e.height]).toEqual([2, 2]);
    expect(e.working.px.length).toBe(4);
  });

  it("caps dimensions", () => {
    const e = engine(2, 2);
    e.resize(99999, 0, WHITE);
    expect([e.width, e.height]).toEqual([2048, 1]);
  });

  it("keeps working and committed as separate buffers after replacing", () => {
    const e = engine(2, 2);
    e.replace(createRaster(3, 3, R));
    e.begin("pencil", 0, 0, OPTS);
    expect(docAt(e, 0, 0)).toBe(R);
    e.end();
    expect(docAt(e, 0, 0)).toBe(K);
    e.undo();
    expect(at(e, 0, 0)).toBe(R);
  });

  it("restores an autosave without creating an undo step", () => {
    const e = engine(2, 2);
    e.restore(createRaster(3, 1, R));
    expect(e.width).toBe(3);
    expect(at(e, 2, 0)).toBe(R);
    expect(e.history.canUndo).toBe(false);
    expect(e.revision).toBe(0);
  });
});

describe("notifications", () => {
  it("asks the view to repaint exactly what changed", () => {
    const e = engine();
    let calls = 0;
    e.subscribeView(() => calls++);
    e.begin("pencil", 3, 4, OPTS);
    expect(calls).toBe(1);
    expect(e.takeViewDirty()).toEqual({ x: 3, y: 4, w: 1, h: 1 });
    expect(e.takeViewDirty()).toBeNull();
  });

  it("only bumps the revision for document changes", () => {
    const e = engine();
    drag(e, "select", 0, 0, 2, 2);
    expect(e.revision).toBe(0);
    expect(e.version).toBeGreaterThan(0);
  });

  it("reads the on-screen color for the eyedropper", () => {
    const e = engine();
    e.begin("pencil", 1, 1, { ...OPTS, color: R });
    expect(e.colorAt(1, 1)).toBe("#ff0000");
    expect(e.colorAt(99, 1)).toBeNull();
  });
});
