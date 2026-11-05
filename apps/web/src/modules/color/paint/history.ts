import type { Raster, Rect } from "./raster";

// Undo records hold only what changed. Each one stores the *other* side of its
// edit, so applying it swaps pixels with the canvas and the same record then
// serves as its own opposite: no separate before and after copies.

/** The most the undo stack may hold. Bytes rather than a step count, because one
 *  canvas-wide fill costs what thousands of small strokes do. */
export const HISTORY_BUDGET_BYTES = 32 * 1024 * 1024;

export type Edit =
  | { kind: "patch"; rect: Rect; pixels: Uint32Array }
  /** A change of dimensions (resize, new, open): the whole previous canvas. */
  | { kind: "replace"; raster: Raster };

const bytesOf = (edit: Edit) =>
  (edit.kind === "patch" ? edit.pixels.length : edit.raster.px.length) * 4;

function swap(edit: Edit, current: Raster): Raster {
  if (edit.kind === "replace") {
    const previous = edit.raster;
    edit.raster = current;
    return previous;
  }
  const { rect, pixels } = edit;
  for (let row = 0; row < rect.h; row++) {
    const base = (rect.y + row) * current.width + rect.x;
    for (let col = 0; col < rect.w; col++) {
      const i = row * rect.w + col;
      const held = pixels[i]!;
      pixels[i] = current.px[base + col]!;
      current.px[base + col] = held;
    }
  }
  return current;
}

export class History {
  private undos: Edit[] = [];
  private redos: Edit[] = [];
  private bytes = 0;

  get canUndo() {
    return this.undos.length > 0;
  }

  get canRedo() {
    return this.redos.length > 0;
  }

  get usedBytes() {
    return this.bytes;
  }

  get undoCount() {
    return this.undos.length;
  }

  /** Record a new edit. Always keeps the newest, even one over budget. */
  push(edit: Edit): void {
    for (const dropped of this.redos) this.bytes -= bytesOf(dropped);
    this.redos = [];
    this.undos.push(edit);
    this.bytes += bytesOf(edit);
    while (this.bytes > HISTORY_BUDGET_BYTES && this.undos.length > 1) {
      this.bytes -= bytesOf(this.undos.shift()!);
    }
  }

  /** Step back. Returns the raster now current, which differs from `current`
   *  only when the edit changed dimensions, plus the edit that was applied. */
  undo(current: Raster): { raster: Raster; edit: Edit } | null {
    return this.step(this.undos, this.redos, current);
  }

  redo(current: Raster): { raster: Raster; edit: Edit } | null {
    return this.step(this.redos, this.undos, current);
  }

  private step(from: Edit[], to: Edit[], current: Raster) {
    const edit = from.pop();
    if (!edit) return null;
    this.bytes -= bytesOf(edit);
    const raster = swap(edit, current);
    this.bytes += bytesOf(edit);
    to.push(edit);
    return { raster, edit };
  }
}
