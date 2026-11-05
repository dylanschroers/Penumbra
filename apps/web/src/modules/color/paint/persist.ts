import { STORAGE_NAMESPACE } from "@penumbra/shared";
import { MAX_DIMENSION } from "./engine";
import type { Raster } from "./raster";

// Keeps the drawing across restarts. IndexedDB because a canvas is megabytes,
// past what localStorage holds, and stays out of the synced SQLite tables. Raw
// pixels rather than PNG so a save never waits on an encoder. Every failure is
// silent: losing the autosave must not get in the way of drawing.

const STORE = "canvas";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${STORAGE_NAMESPACE}.paint`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadCanvas(): Promise<Raster | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await open();
    const saved = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const { width, height, buffer } = (saved ?? {}) as Partial<{
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }>;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width! < 1 ||
      height! < 1 ||
      width! > MAX_DIMENSION ||
      height! > MAX_DIMENSION ||
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength !== width! * height! * 4
    ) {
      return null;
    }
    return { width: width!, height: height!, px: new Uint32Array(buffer) };
  } catch {
    return null;
  }
}

export async function saveCanvas(raster: Raster): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await open();
    db.transaction(STORE, "readwrite")
      .objectStore(STORE)
      .put(
        {
          width: raster.width,
          height: raster.height,
          buffer: raster.px.buffer.slice(0),
        },
        KEY,
      );
    db.close();
  } catch {
    // Non-fatal.
  }
}
