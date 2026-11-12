import { History } from "./history";
import {
  blendRgba,
  blit,
  clipRect,
  copyRect,
  cornersToRect,
  createRaster,
  drawEllipse,
  drawLine,
  fillRect,
  floodFill,
  pixelToHex,
  type Raster,
  type Rect,
  readRect,
  rotate90,
  strokeRect,
  unionRect,
} from "./raster";

// The drawing document, free of DOM and React so all of it runs under test.
//
// Two rasters: `committed` is the document, `working` is what is on screen. A
// gesture draws into `working` and tracks what it touched in `pending`; a shape
// preview redraws by restoring that region first. Commit turns the region into
// one undo record, and cancel just restores it.

export type Tool =
  | "pencil"
  | "brush"
  | "eraser"
  | "fill"
  | "picker"
  | "line"
  | "rect"
  | "ellipse"
  | "select"
  | "text";

export interface PixelBlock {
  w: number;
  h: number;
  px: Uint32Array;
}

export interface Selection {
  /** Where it sits now. A floating block may hang off the canvas. */
  rect: Rect;
  /** The pixels being moved or pasted; null until the marquee is dragged. */
  float: Uint32Array | null;
  /** The area a move lifted out of the canvas, shown in `back` until commit. */
  hole: Rect | null;
  back: number;
}

export interface GestureOptions {
  color: number;
  /** The other color: the eraser's paint and what a moved selection leaves. */
  back: number;
  size: number;
  filled: boolean;
}

export const DEFAULT_WIDTH = 800;
export const DEFAULT_HEIGHT = 600;
/** Two full buffers per canvas, so 2048² is already 32 MB before any undo. */
export const MAX_DIMENSION = 2048;
export const WHITE = 0xffffffff;

type Gesture =
  | { kind: "stroke"; x: number; y: number; size: number; color: number }
  | {
      kind: "shape";
      tool: "line" | "rect" | "ellipse";
      x: number;
      y: number;
      opts: GestureOptions;
    }
  | { kind: "marquee"; x: number; y: number }
  | { kind: "move"; dx: number; dy: number };

export function clampDimension(n: number): number {
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(n) || 1));
}

/** Shift-drag: snap a line to 45° steps. */
function snapLine(x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx > 2 * ady) return { x: x1, y: y0 };
  if (ady > 2 * adx) return { x: x0, y: y1 };
  const d = Math.max(adx, ady);
  return { x: x0 + Math.sign(dx) * d, y: y0 + Math.sign(dy) * d };
}

/** Shift-drag: square a rectangle or ellipse. */
function snapSquare(x0: number, y0: number, x1: number, y1: number) {
  const d = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return {
    x: x0 + (x1 < x0 ? -d : d),
    y: y0 + (y1 < y0 ? -d : d),
  };
}

export class PaintEngine {
  committed: Raster;
  working: Raster;
  readonly history = new History();
  selection: Selection | null = null;
  /** Bumps whenever the document itself changes, for autosave. */
  revision = 0;
  /** Bumps on anything the toolbar shows, including selection changes. */
  version = 0;

  private pending: Rect | null = null;
  private viewDirty: Rect | null = null;
  private gesture: Gesture | null = null;
  private listeners = new Set<() => void>();
  private viewListeners = new Set<() => void>();

  constructor(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
    this.committed = createRaster(width, height, WHITE);
    this.working = createRaster(width, height, WHITE);
  }

  get width() {
    return this.committed.width;
  }

  get height() {
    return this.committed.height;
  }

  get busy() {
    return this.gesture !== null;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  subscribeView = (fn: () => void) => {
    this.viewListeners.add(fn);
    return () => {
      this.viewListeners.delete(fn);
    };
  };

  getVersion = () => this.version;

  /** The region the screen still needs, cleared by reading it. */
  takeViewDirty(): Rect | null {
    const rect = this.viewDirty;
    this.viewDirty = null;
    return rect;
  }

  colorAt(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return pixelToHex(this.working.px[y * this.width + x]!);
  }

  begin(
    tool: Tool,
    x: number,
    y: number,
    opts: GestureOptions,
    constrain = false,
  ): void {
    if (this.gesture) return;
    if (tool !== "select") this.commitSelection();

    switch (tool) {
      case "pencil":
      case "brush":
      case "eraser": {
        const size = tool === "pencil" ? 1 : opts.size;
        const color = tool === "eraser" ? opts.back : opts.color;
        this.gesture = { kind: "stroke", x, y, size, color };
        this.touch(drawLine(this.working, x, y, x, y, size, color));
        break;
      }
      case "fill":
        this.touch(floodFill(this.working, x, y, opts.color));
        this.commit();
        break;
      case "line":
      case "rect":
      case "ellipse":
        this.gesture = { kind: "shape", tool, x, y, opts };
        this.drawShape(x, y, constrain);
        break;
      case "select":
        this.beginSelect(x, y, opts);
        break;
      default:
        break;
    }
    this.flushView();
  }

  move(x: number, y: number, constrain = false): void {
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case "stroke":
        this.touch(drawLine(this.working, g.x, g.y, x, y, g.size, g.color));
        g.x = x;
        g.y = y;
        break;
      case "shape":
        this.drawShape(x, y, constrain);
        break;
      case "marquee":
        this.selection = {
          rect: this.clipMarquee(g.x, g.y, x, y),
          float: null,
          hole: null,
          back: WHITE,
        };
        this.notify();
        break;
      case "move":
        this.selection!.rect.x = x - g.dx;
        this.selection!.rect.y = y - g.dy;
        this.renderFloat();
        this.notify();
        break;
    }
    this.flushView();
  }

  end(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.kind === "stroke" || g.kind === "shape") this.commit();
    // A plain click, with nothing dragged out, only clears the old selection.
    if (
      g.kind === "marquee" &&
      this.selection?.rect.w === 1 &&
      this.selection.rect.h === 1
    ) {
      this.selection = null;
    }
    this.notify();
  }

  /** Esc: back out of whatever is in progress, one layer at a time. */
  cancel(): void {
    if (this.gesture) {
      const wasMarquee = this.gesture.kind === "marquee";
      this.gesture = null;
      if (wasMarquee) this.selection = null;
      else if (!this.selection) this.restorePending();
    }
    if (this.selection) {
      if (this.selection.float) this.restorePending();
      this.selection = null;
    }
    this.flushView();
    this.notify();
  }

  private drawShape(x: number, y: number, constrain: boolean): void {
    const g = this.gesture;
    if (g?.kind !== "shape") return;
    this.restorePending();
    const { color, size, filled } = g.opts;
    if (g.tool === "line") {
      const end = constrain ? snapLine(g.x, g.y, x, y) : { x, y };
      this.touch(drawLine(this.working, g.x, g.y, end.x, end.y, size, color));
      return;
    }
    const end = constrain ? snapSquare(g.x, g.y, x, y) : { x, y };
    const rect = cornersToRect(g.x, g.y, end.x, end.y);
    if (g.tool === "rect") {
      this.touch(
        filled
          ? fillRect(this.working, rect, color)
          : strokeRect(this.working, rect, size, color),
      );
    } else {
      this.touch(
        drawEllipse(this.working, rect, color, filled ? undefined : size),
      );
    }
  }

  private clipMarquee(x0: number, y0: number, x1: number, y1: number): Rect {
    const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));
    return cornersToRect(
      clamp(x0, this.width - 1),
      clamp(y0, this.height - 1),
      clamp(x1, this.width - 1),
      clamp(y1, this.height - 1),
    );
  }

  private beginSelect(x: number, y: number, opts: GestureOptions): void {
    const s = this.selection;
    if (s && hits(s.rect, x, y)) {
      if (!s.float) {
        s.float = readRect(this.committed, s.rect);
        s.hole = { ...s.rect };
        s.back = opts.back;
        this.renderFloat();
      }
      this.gesture = { kind: "move", dx: x - s.rect.x, dy: y - s.rect.y };
      return;
    }
    this.commitSelection();
    this.gesture = { kind: "marquee", x, y };
    this.selection = {
      rect: this.clipMarquee(x, y, x, y),
      float: null,
      hole: null,
      back: WHITE,
    };
    this.notify();
  }

  private renderFloat(): void {
    const s = this.selection;
    if (!s?.float) return;
    this.restorePending();
    if (s.hole) this.touch(fillRect(this.working, s.hole, s.back));
    const { x, y, w, h } = s.rect;
    this.touch(blit(this.working, x, y, w, h, s.float));
  }

  /** Drop the selection, landing any floating pixels where they sit. */
  commitSelection(): void {
    if (!this.selection) return;
    const hadFloat = this.selection.float !== null;
    this.selection = null;
    if (hadFloat) this.commit();
    this.notify();
  }

  selectAll(): void {
    this.commitSelection();
    this.selection = {
      rect: { x: 0, y: 0, w: this.width, h: this.height },
      float: null,
      hole: null,
      back: WHITE,
    };
    this.notify();
  }

  /** The selected pixels, or the whole canvas without a selection. */
  copyBlock(): PixelBlock {
    const s = this.selection;
    if (s?.float) return { w: s.rect.w, h: s.rect.h, px: s.float.slice() };
    const rect = s?.rect ?? { x: 0, y: 0, w: this.width, h: this.height };
    return { w: rect.w, h: rect.h, px: readRect(this.committed, rect) };
  }

  /** Delete: clear the selection to `back`. A pasted block just disappears. */
  deleteSelection(back: number): void {
    const s = this.selection;
    if (!s) return;
    if (s.float) this.restorePending();
    const hole = s.float ? s.hole : s.rect;
    this.selection = null;
    if (hole) {
      this.touch(fillRect(this.working, hole, s.float ? s.back : back));
      this.commit();
    }
    this.flushView();
    this.notify();
  }

  /** Drop a block on the canvas as a floating selection, ready to move. */
  paste(block: PixelBlock): void {
    this.commitSelection();
    this.selection = {
      rect: { x: 0, y: 0, w: block.w, h: block.h },
      float: block.px,
      hole: null,
      back: WHITE,
    };
    this.renderFloat();
    this.flushView();
    this.notify();
  }

  /** Rotate the selection 90° about its center, or the whole canvas without one.
   *  A selection lifts first, so however many turns it takes, it lands as one
   *  undo step, and four turns land as none. */
  rotate(clockwise: boolean, back: number): void {
    if (this.gesture) return;
    const s = this.selection;
    if (!s) {
      const { width, height, px } = this.committed;
      this.replace({
        width: height,
        height: width,
        px: rotate90(px, width, height, clockwise),
      });
      return;
    }
    if (!s.float) {
      s.float = readRect(this.committed, s.rect);
      s.hole = { ...s.rect };
      s.back = back;
    }
    const { x, y, w, h } = s.rect;
    s.float = rotate90(s.float, w, h, clockwise);
    // trunc, not floor: rounding the same way in both directions is what stops
    // a block with an odd size difference creeping sideways as it turns.
    s.rect = {
      x: x + Math.trunc((w - h) / 2),
      y: y + Math.trunc((h - w) / 2),
      w: h,
      h: w,
    };
    this.renderFloat();
    this.flushView();
    this.notify();
  }

  /** Composite rendered text into the canvas as one undo step. */
  stampRgba(
    x: number,
    y: number,
    w: number,
    h: number,
    rgba: Uint8ClampedArray,
  ): void {
    this.commitSelection();
    this.touch(blendRgba(this.working, x, y, w, h, rgba));
    this.commit();
    this.flushView();
  }

  /** Change dimensions, keeping the top-left of the drawing. */
  resize(width: number, height: number, back: number): void {
    const w = clampDimension(width);
    const h = clampDimension(height);
    if (w === this.width && h === this.height) return;
    this.commitSelection();
    const next = createRaster(w, h, back);
    const keep = clipRect({ x: 0, y: 0, w: this.width, h: this.height }, w, h)!;
    blit(next, 0, 0, keep.w, keep.h, readRect(this.committed, keep));
    this.replace(next);
  }

  /** Swap in a whole new canvas (New, Open) as one undo step. */
  replace(next: Raster): void {
    this.selection = null;
    this.pending = null;
    this.history.push({ kind: "replace", raster: this.committed });
    this.adopt(next);
    this.revision++;
    this.notify();
  }

  /** Load an autosaved canvas. Not an edit, so nothing to undo. */
  restore(saved: Raster): void {
    this.adopt(saved);
    this.notify();
  }

  undo(): void {
    if (this.gesture) return;
    if (this.selection?.float) {
      this.cancel();
      return;
    }
    this.selection = null;
    this.apply(this.history.undo(this.committed));
  }

  redo(): void {
    if (this.gesture) return;
    this.commitSelection();
    this.apply(this.history.redo(this.committed));
  }

  private apply(step: ReturnType<History["undo"]>): void {
    if (!step) {
      this.notify();
      return;
    }
    if (step.edit.kind === "replace") {
      this.adopt(step.raster);
    } else {
      copyRect(this.committed, this.working, step.edit.rect);
      this.addViewDirty(step.edit.rect);
    }
    this.revision++;
    this.flushView();
    this.notify();
  }

  private adopt(raster: Raster): void {
    this.committed = raster;
    this.working = {
      width: raster.width,
      height: raster.height,
      px: raster.px.slice(),
    };
    this.addViewDirty({ x: 0, y: 0, w: raster.width, h: raster.height });
    this.flushView();
  }

  private touch(rect: Rect | null): void {
    this.pending = unionRect(this.pending, rect);
    this.addViewDirty(rect);
  }

  private addViewDirty(rect: Rect | null): void {
    this.viewDirty = unionRect(this.viewDirty, rect);
  }

  private restorePending(): void {
    if (!this.pending) return;
    copyRect(this.committed, this.working, this.pending);
    this.addViewDirty(this.pending);
    this.pending = null;
  }

  /** Make `pending` part of the document, as one undo record if it changed. */
  private commit(): void {
    const rect = this.pending;
    this.pending = null;
    if (!rect || !this.differs(rect)) return;
    this.history.push({
      kind: "patch",
      rect,
      pixels: readRect(this.committed, rect),
    });
    copyRect(this.working, this.committed, rect);
    this.revision++;
    this.notify();
  }

  private differs(rect: Rect): boolean {
    const { px: a, width } = this.committed;
    const b = this.working.px;
    for (let row = 0; row < rect.h; row++) {
      const start = (rect.y + row) * width + rect.x;
      for (let i = start; i < start + rect.w; i++) {
        if (a[i] !== b[i]) return true;
      }
    }
    return false;
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private flushView(): void {
    if (!this.viewDirty) return;
    for (const fn of this.viewListeners) fn();
  }
}

function hits(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
  );
}
