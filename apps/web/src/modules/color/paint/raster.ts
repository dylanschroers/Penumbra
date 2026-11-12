// Pixel drawing for Paint, on a plain buffer rather than canvas 2D: canvas always
// anti-aliases lines, and the fringe that leaves breaks exact-match flood fill.
//
// Pixels are opaque RGBA packed for a little-endian Uint32Array (0xAABBGGRR), the
// byte order ImageData expects on every platform the app ships to.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Raster {
  width: number;
  height: number;
  px: Uint32Array;
}

export function createRaster(
  width: number,
  height: number,
  fill: number,
): Raster {
  return { width, height, px: new Uint32Array(width * height).fill(fill) };
}

export function hexToPixel(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return (
    (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0
  );
}

export function pixelToHex(pixel: number): string {
  const r = pixel & 0xff;
  const g = (pixel >> 8) & 0xff;
  const b = (pixel >> 16) & 0xff;
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * The pixel under a pointer coordinate, along one axis.
 *
 * `start` is rounded because the canvas paints snapped to whole pixels however
 * fractional its layout box, and WebKit reports integer pointer positions.
 *
 * Multiplying before dividing matters: (110 / 600) * 600 is 109.99999999999999,
 * which floors a pixel short, while 110 * 600 / 600 is exact.
 */
export function clientToPixel(
  client: number,
  start: number,
  cssSize: number,
  pixels: number,
): number {
  return Math.floor(((client - Math.round(start)) * pixels) / cssSize);
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function clipRect(
  rect: Rect,
  width: number,
  height: number,
): Rect | null {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const w = Math.min(width, rect.x + rect.w) - x;
  const h = Math.min(height, rect.y + rect.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

export function readRect(r: Raster, rect: Rect): Uint32Array {
  const out = new Uint32Array(rect.w * rect.h);
  for (let row = 0; row < rect.h; row++) {
    const start = (rect.y + row) * r.width + rect.x;
    out.set(r.px.subarray(start, start + rect.w), row * rect.w);
  }
  return out;
}

/** A `w`×`h` block turned 90°, which makes it `h`×`w`. */
export function rotate90(
  pixels: Uint32Array,
  w: number,
  h: number,
  clockwise: boolean,
): Uint32Array {
  const out = new Uint32Array(pixels.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = clockwise ? x * h + (h - 1 - y) : (w - 1 - x) * h + y;
      out[at] = pixels[y * w + x]!;
    }
  }
  return out;
}

/** Copy `rect` between same-sized rasters. */
export function copyRect(src: Raster, dst: Raster, rect: Rect): void {
  for (let row = 0; row < rect.h; row++) {
    const start = (rect.y + row) * src.width + rect.x;
    dst.px.set(src.px.subarray(start, start + rect.w), start);
  }
}

/** Write a `w`×`h` block with its top-left at (x, y), clipped to the raster. */
export function blit(
  r: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  pixels: Uint32Array,
): Rect | null {
  const clipped = clipRect({ x, y, w, h }, r.width, r.height);
  if (!clipped) return null;
  for (let row = 0; row < clipped.h; row++) {
    const from = (clipped.y + row - y) * w + clipped.x - x;
    r.px.set(
      pixels.subarray(from, from + clipped.w),
      (clipped.y + row) * r.width + clipped.x,
    );
  }
  return clipped;
}

/** Composite non-premultiplied RGBA (from getImageData) over the raster. */
export function blendRgba(
  r: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: Uint8ClampedArray,
): Rect | null {
  const clipped = clipRect({ x, y, w, h }, r.width, r.height);
  if (!clipped) return null;
  for (let row = 0; row < clipped.h; row++) {
    for (let col = 0; col < clipped.w; col++) {
      const i = ((clipped.y + row - y) * w + clipped.x + col - x) * 4;
      const a = rgba[i + 3]!;
      if (a === 0) continue;
      const at = (clipped.y + row) * r.width + clipped.x + col;
      const dst = r.px[at]!;
      const mix = (s: number, d: number) =>
        Math.round((s * a + d * (255 - a)) / 255);
      r.px[at] =
        (0xff000000 |
          (mix(rgba[i + 2]!, (dst >> 16) & 0xff) << 16) |
          (mix(rgba[i + 1]!, (dst >> 8) & 0xff) << 8) |
          mix(rgba[i]!, dst & 0xff)) >>>
        0;
    }
  }
  return clipped;
}

export function fillRect(r: Raster, rect: Rect, color: number): Rect | null {
  const clipped = clipRect(rect, r.width, r.height);
  if (!clipped) return null;
  for (let row = 0; row < clipped.h; row++) {
    const start = (clipped.y + row) * r.width + clipped.x;
    r.px.fill(color, start, start + clipped.w);
  }
  return clipped;
}

function hspan(r: Raster, y: number, x0: number, x1: number, color: number) {
  if (y < 0 || y >= r.height) return;
  const from = Math.max(0, x0);
  const to = Math.min(r.width - 1, x1);
  if (from <= to) r.px.fill(color, y * r.width + from, y * r.width + to + 1);
}

type Spans = { dy: number; x0: number; x1: number }[];
const brushes = new Map<number, Spans>();

/** A round brush as one horizontal span per row, offset from its center pixel. */
function brushSpans(size: number): Spans {
  const cached = brushes.get(size);
  if (cached) return cached;
  const c = (size - 1) / 2;
  const spans: Spans = [];
  for (let row = 0; row < size; row++) {
    const hw = Math.sqrt(Math.max(0, (size / 2) ** 2 - (row - c) ** 2));
    const left = Math.ceil(c - hw);
    const offset = (size - 1) >> 1;
    spans.push({
      dy: row - offset,
      x0: left - offset,
      x1: size - 1 - left - offset,
    });
  }
  brushes.set(size, spans);
  return spans;
}

/** Bresenham between two points, stamping the brush at each. */
export function drawLine(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  color: number,
): Rect | null {
  const spans = brushSpans(size);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    for (const s of spans) hspan(r, y + s.dy, x + s.x0, x + s.x1, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  const before = (size - 1) >> 1;
  return clipRect(
    {
      x: Math.min(x0, x1) - before,
      y: Math.min(y0, y1) - before,
      w: dx + size,
      h: dy + size,
    },
    r.width,
    r.height,
  );
}

/** The box two opposite corners span, inclusive of both. */
export function cornersToRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0) + 1,
    h: Math.abs(y1 - y0) + 1,
  };
}

export function strokeRect(
  r: Raster,
  rect: Rect,
  size: number,
  color: number,
): Rect | null {
  const { x, y, w, h } = rect;
  const t = Math.min(size, Math.ceil(w / 2), Math.ceil(h / 2));
  fillRect(r, { x, y, w, h: t }, color);
  fillRect(r, { x, y: y + h - t, w, h: t }, color);
  fillRect(r, { x, y, w: t, h }, color);
  fillRect(r, { x: x + w - t, y, w: t, h }, color);
  return clipRect(rect, r.width, r.height);
}

/** Half-width of an ellipse at `dy` from its center row, measured to pixel
 *  edges so a small circle comes out round instead of pointed. */
function halfWidth(a: number, b: number, dy: number): number | null {
  const ratio = dy / (b + 0.5);
  if (a < 0 || b < 0 || Math.abs(ratio) > 1) return null;
  return (a + 0.5) * Math.sqrt(1 - ratio * ratio);
}

/** A filled ellipse, or an outline `stroke` pixels thick when given. Mirroring
 *  the right edge off the left keeps it symmetric at half-pixel centers. */
export function drawEllipse(
  r: Raster,
  rect: Rect,
  color: number,
  stroke?: number,
): Rect | null {
  const a = (rect.w - 1) / 2;
  const b = (rect.h - 1) / 2;
  const cx = rect.x + a;
  const cy = rect.y + b;
  const edgeSum = 2 * rect.x + rect.w - 1;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const dy = y - cy;
    const outer = halfWidth(a, b, dy);
    if (outer === null) continue;
    const l = Math.ceil(cx - outer);
    const inner =
      stroke === undefined ? null : halfWidth(a - stroke, b - stroke, dy);
    if (inner === null) {
      hspan(r, y, l, edgeSum - l, color);
    } else {
      const il = Math.ceil(cx - inner);
      hspan(r, y, l, il - 1, color);
      hspan(r, y, edgeSum - il + 1, edgeSum - l, color);
    }
  }
  return clipRect(rect, r.width, r.height);
}

/** Scanline fill of the exact-match region containing (x, y). */
export function floodFill(
  r: Raster,
  x: number,
  y: number,
  color: number,
): Rect | null {
  const { width, height, px } = r;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const target = px[y * width + x]!;
  if (target === color) return null;

  let minX = x;
  let maxX = x;
  let minY = y;
  let maxY = y;
  const stack = [x, y];
  while (stack.length > 0) {
    const sy = stack.pop()!;
    const sx = stack.pop()!;
    if (px[sy * width + sx] !== target) continue;

    let l = sx;
    while (l > 0 && px[sy * width + l - 1] === target) l--;
    let rr = sx;
    while (rr < width - 1 && px[sy * width + rr + 1] === target) rr++;
    px.fill(color, sy * width + l, sy * width + rr + 1);

    if (l < minX) minX = l;
    if (rr > maxX) maxX = rr;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let inRun = false;
      for (let nx = l; nx <= rr; nx++) {
        const match = px[ny * width + nx] === target;
        if (match && !inRun) stack.push(nx, ny);
        inRun = match;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
