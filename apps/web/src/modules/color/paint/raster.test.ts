import { describe, expect, it } from "vitest";
import {
  blendRgba,
  blit,
  cornersToRect,
  createRaster,
  drawEllipse,
  drawLine,
  floodFill,
  hexToPixel,
  pixelToHex,
  type Raster,
  strokeRect,
} from "./raster";

const W = hexToPixel("#ffffff");
const K = hexToPixel("#000000");
const R = hexToPixel("#ff0000");

/** A raster as rows of `#` (not white) and `.` (white), to read at a glance. */
function art(r: Raster): string[] {
  const rows: string[] = [];
  for (let y = 0; y < r.height; y++) {
    let row = "";
    for (let x = 0; x < r.width; x++) {
      row += r.px[y * r.width + x] === W ? "." : "#";
    }
    rows.push(row);
  }
  return rows;
}

describe("color packing", () => {
  it("round-trips hex through the little-endian pixel", () => {
    for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0a0b0c"]) {
      expect(pixelToHex(hexToPixel(hex))).toBe(hex);
    }
  });

  it("lays bytes out as RGBA, the order ImageData reads", () => {
    const px = new Uint32Array([hexToPixel("#112233")]);
    expect([...new Uint8Array(px.buffer)]).toEqual([0x11, 0x22, 0x33, 0xff]);
  });
});

describe("drawLine", () => {
  it("reaches both endpoints without gaps or anti-aliased colors", () => {
    const r = createRaster(6, 3, W);
    drawLine(r, 0, 0, 5, 2, 1, K);
    expect(r.px[0]).toBe(K);
    expect(r.px[2 * 6 + 5]).toBe(K);
    expect(new Set(r.px)).toEqual(new Set([W, K]));
    expect(r.px.filter((p) => p === K).length).toBe(6);
  });

  it("reports exactly the box it could have touched", () => {
    const r = createRaster(10, 10, W);
    expect(drawLine(r, 2, 3, 5, 3, 3, K)).toEqual({ x: 1, y: 2, w: 6, h: 3 });
  });

  it("clips at the edges instead of wrapping to the next row", () => {
    const r = createRaster(4, 3, W);
    const dirty = drawLine(r, 3, 1, 3, 1, 3, K);
    expect(art(r)).toEqual(["..##", "..##", "..##"]);
    expect(dirty).toEqual({ x: 2, y: 0, w: 2, h: 3 });
  });

  it("returns nothing for a stroke wholly off the canvas", () => {
    const r = createRaster(4, 4, W);
    expect(drawLine(r, -9, -9, -8, -8, 1, K)).toBeNull();
    expect(art(r).join("")).not.toContain("#");
  });

  it("stamps a round brush", () => {
    const r = createRaster(5, 5, W);
    drawLine(r, 2, 2, 2, 2, 5, K);
    expect(art(r)).toEqual([".###.", "#####", "#####", "#####", ".###."]);
  });
});

describe("shapes", () => {
  it("strokes a rectangle and leaves the middle alone", () => {
    const r = createRaster(5, 4, W);
    strokeRect(r, cornersToRect(4, 3, 0, 0), 1, K);
    expect(art(r)).toEqual(["#####", "#...#", "#...#", "#####"]);
  });

  it("does not overflow a thick stroke on a thin rectangle", () => {
    const r = createRaster(5, 3, W);
    strokeRect(r, { x: 1, y: 1, w: 2, h: 1 }, 8, K);
    expect(art(r)).toEqual([".....", ".##..", "....."]);
  });

  it("fills a round ellipse", () => {
    const r = createRaster(5, 5, W);
    drawEllipse(r, { x: 0, y: 0, w: 5, h: 5 }, K);
    expect(art(r)).toEqual([".###.", "#####", "#####", "#####", ".###."]);
  });

  it("outlines an ellipse with a hollow middle and no gaps", () => {
    const r = createRaster(7, 7, W);
    drawEllipse(r, { x: 0, y: 0, w: 7, h: 7 }, K, 1);
    expect(art(r)).toEqual([
      "..###..",
      ".#...#.",
      "#.....#",
      "#.....#",
      "#.....#",
      ".#...#.",
      "..###..",
    ]);
  });

  it("stays symmetric on an even-sized box", () => {
    const r = createRaster(8, 6, W);
    drawEllipse(r, { x: 0, y: 0, w: 8, h: 6 }, K, 1);
    const rows = art(r);
    for (const row of rows) expect(row).toBe([...row].reverse().join(""));
    expect(rows).toEqual([...rows].reverse());
  });

  it("draws a one-pixel-thin ellipse as a line", () => {
    const r = createRaster(5, 1, W);
    drawEllipse(r, { x: 0, y: 0, w: 5, h: 1 }, K, 1);
    expect(art(r)).toEqual(["#####"]);
  });
});

describe("floodFill", () => {
  it("stops at a boundary", () => {
    const r = createRaster(5, 3, W);
    drawLine(r, 2, 0, 2, 2, 1, K);
    const dirty = floodFill(r, 0, 0, R);
    expect(r.px[0]).toBe(R);
    expect(r.px[4]).toBe(W);
    expect(dirty).toEqual({ x: 0, y: 0, w: 2, h: 3 });
  });

  it("does not leak through a diagonal", () => {
    const r = createRaster(3, 3, W);
    drawLine(r, 0, 2, 2, 0, 1, K);
    floodFill(r, 0, 0, R);
    expect(r.px[2 * 3 + 2]).toBe(W);
  });

  it("is a no-op on the same color or off the canvas", () => {
    const r = createRaster(3, 3, W);
    expect(floodFill(r, 1, 1, W)).toBeNull();
    expect(floodFill(r, 9, 9, K)).toBeNull();
  });

  it("fills a whole large canvas through a comb without overflowing", () => {
    const r = createRaster(400, 300, W);
    for (let x = 1; x < 400; x += 2) drawLine(r, x, 0, x, 298, 1, K);
    floodFill(r, 0, 0, R);
    expect(r.px[0]).toBe(R);
    expect(r.px[399 + 299 * 400]).toBe(R);
    expect(r.px.filter((p) => p === W).length).toBe(0);
  });
});

describe("blit and blend", () => {
  it("clips a block hanging off every side", () => {
    const r = createRaster(2, 2, W);
    const block = new Uint32Array(16).fill(K);
    expect(blit(r, -1, -1, 4, 4, block)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(art(r)).toEqual(["##", "##"]);
  });

  it("copies the right part of a clipped block", () => {
    const r = createRaster(1, 1, W);
    blit(r, -1, 0, 2, 1, new Uint32Array([K, R]));
    expect(r.px[0]).toBe(R);
  });

  it("composites partial alpha and skips transparent pixels", () => {
    const r = createRaster(2, 1, W);
    blendRgba(r, 0, 0, 2, 1, new Uint8ClampedArray([0, 0, 0, 128, 0, 0, 0, 0]));
    expect(pixelToHex(r.px[0]!)).toBe("#7f7f7f");
    expect(r.px[1]).toBe(W);
  });
});
