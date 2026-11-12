import {
  mkdir,
  open,
  readdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// Client-local models and datasets land here so Studio can read them. The
// client controls the name, so writes must never escape the upload root.

const UPLOAD_KINDS = new Set(["datasets", "models"]);

export function uploadRoot(): string {
  return (
    process.env.PENUMBRA_UPLOAD_DIR ?? join(homedir(), ".penumbra", "uploads")
  );
}

/**
 * The security boundary: rejects unknown kinds, empty or absolute `rel`, and
 * `..` escapes.
 */
export function resolveDest(root: string, kind: string, rel: string): string {
  if (!UPLOAD_KINDS.has(kind)) throw new Error(`bad upload kind: ${kind}`);
  if (!rel || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error("rel must be a relative path");
  }
  const kindDir = resolve(root, kind);
  const dest = resolve(kindDir, rel);
  // The `+ sep` stops a sibling like `<root>/models-evil`.
  if (dest !== kindDir && !dest.startsWith(kindDir + sep)) {
    throw new Error("path escapes the upload root");
  }
  return dest;
}

export const SPACE_HEADROOM = 256 * 1024 * 1024;

/**
 * Probes upward because the root may not exist yet. Infinity when unmeasurable:
 * the write still reports ENOSPC.
 */
export async function freeSpace(dir: string): Promise<number> {
  let probe = resolve(dir);
  for (;;) {
    try {
      const fs = await statfs(probe);
      return Math.max(0, fs.bavail * fs.bsize - SPACE_HEADROOM);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return Number.POSITIVE_INFINITY;
      probe = parent;
    }
  }
}

/** Distinguishes a path we hold from a name only the trainer can resolve. */
export async function isLocalFile(path: string): Promise<boolean> {
  const s = await stat(path).catch(() => null);
  return s?.isFile() ?? false;
}

export function isOutOfSpace(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOSPC";
}

/** Files whose host size differs from the client's (missing counts). */
export function computeNeed(
  files: { rel: string; size: number }[],
  sizeOf: (rel: string) => number | undefined,
): string[] {
  return files.filter((f) => sizeOf(f.rel) !== f.size).map((f) => f.rel);
}

/** POSIX separators. Empty when `dir` doesn't exist. */
export async function dirFileSizes(
  dir: string,
): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // not created yet, or unreadable
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        const s = await stat(full).catch(() => null);
        if (s) sizes[rel] = s.size;
      }
    }
  }
  await walk(dir, "");
  return sizes;
}

export interface DatasetFile {
  name: string;
  path: string;
  size: number;
}

/** Not filtered by extension: `resolveDest` already decided what may be here. */
export async function listDatasets(): Promise<DatasetFile[]> {
  const dir = join(uploadRoot(), "datasets");
  const sizes = await dirFileSizes(dir);
  return Object.entries(sizes)
    .map(([name, size]) => ({ name, path: join(dir, name), size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Offset 0 truncates, so a re-upload starts clean. Chunks arrive in order. */
export async function writeChunk(
  dest: string,
  offset: number,
  data: Buffer,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (offset === 0) {
    await writeFile(dest, data);
    return;
  }
  const handle = await open(dest, "r+");
  try {
    await handle.write(data, 0, data.length, offset);
  } finally {
    await handle.close();
  }
}
