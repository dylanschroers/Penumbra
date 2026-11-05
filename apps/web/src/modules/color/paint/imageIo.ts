import { invoke } from "@tauri-apps/api/core";
import { MAX_DIMENSION, type PixelBlock } from "./engine";

// Everything that crosses between the pixel buffer and the browser's image
// world: PNG encoding, decoding opened and pasted images, text, the clipboard.

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable.");
  return ctx;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function encodePng(block: PixelBlock): Promise<Blob> {
  const canvas = makeCanvas(block.w, block.h);
  const bytes = new Uint8ClampedArray(
    block.px.buffer as ArrayBuffer,
    block.px.byteOffset,
    block.px.byteLength,
  );
  context(canvas).putImageData(new ImageData(bytes, block.w, block.h), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not encode the PNG.")),
      "image/png",
    );
  });
}

/** Decode an image to opaque pixels, flattened on white and scaled to the cap. */
export async function decodeImage(file: Blob): Promise<PixelBlock> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("That image could not be read."));
      image.src = url;
    });
    const scale = Math.min(
      1,
      MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = context(makeCanvas(w, h));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return { w, h, px: new Uint32Array(data.buffer) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Rasterize one line of text to RGBA, for compositing over the canvas. */
export function renderText(
  text: string,
  fontPx: number,
  hex: string,
): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  const font = `${fontPx}px sans-serif`;
  const probe = context(makeCanvas(1, 1));
  probe.font = font;
  const w = Math.min(MAX_DIMENSION, Math.ceil(probe.measureText(text).width));
  const h = Math.ceil(fontPx * 1.25);
  if (w < 1) return null;
  const ctx = context(makeCanvas(w, h));
  ctx.font = font;
  ctx.fillStyle = hex;
  ctx.textBaseline = "top";
  ctx.fillText(text, 0, 0);
  return { w, h, rgba: ctx.getImageData(0, 0, w, h).data };
}

/**
 * Save as a PNG. Returns the path on desktop, "" for a browser download, or null
 * if the user backed out of the save dialog.
 */
export async function savePng(block: PixelBlock): Promise<string | null> {
  const blob = await encodePng(block);
  if (isTauri) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      return await invoke<string | null>("paint_save_png", bytes);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "drawing.png";
  link.click();
  URL.revokeObjectURL(url);
  return "";
}

/** Put a block on the system clipboard. Passing the blob as a promise keeps the
 *  write inside the user gesture, which WebKit requires. */
export async function copyImage(block: PixelBlock): Promise<void> {
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": encodePng(block) }),
  ]);
}

/** The clipboard's image, or null if it holds none or refuses to be read. */
export async function readClipboardImage(): Promise<PixelBlock | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return await decodeImage(await item.getType(type));
    }
  } catch {
    // Permission denied or unsupported; the caller falls back.
  }
  return null;
}
