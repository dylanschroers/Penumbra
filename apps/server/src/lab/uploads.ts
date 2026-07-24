import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// Where the client's local models and datasets land on the Studio host, so a
// run started from a laptop can point Studio at a path Studio can actually read
// (the transfer half of "models live on the client"; docs/model_lab_plan.md →
// Deployment topology). Files arrive chunked via POST /lab/upload and are used
// verbatim as model_name / local_datasets.
//
// This host writes them; Studio, co-located, reads them. The bearer that guards
// the route is the whole trust boundary — so the one thing that must be airtight
// here is that a client-supplied name can never write outside the upload root.

const UPLOAD_KINDS = new Set(["datasets", "models"]);

/** The upload root on this host. Override with PENUMBRA_UPLOAD_DIR. */
export function uploadRoot(): string {
  return (
    process.env.PENUMBRA_UPLOAD_DIR ?? join(homedir(), ".penumbra", "uploads")
  );
}

/**
 * Resolve `<root>/<kind>/<rel>` and prove the result stays inside the kind
 * directory. Rejects an unknown kind, an empty or absolute `rel`, and any `..`
 * that would climb out (path traversal) — the client controls `rel`, so this is
 * the security boundary.
 */
export function resolveDest(root: string, kind: string, rel: string): string {
  if (!UPLOAD_KINDS.has(kind)) throw new Error(`bad upload kind: ${kind}`);
  if (!rel || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error("rel must be a relative path");
  }
  const kindDir = resolve(root, kind);
  const dest = resolve(kindDir, rel);
  // `resolve` collapses `..`, so an escape shows up as a path no longer under
  // kindDir. The `+ sep` guards against a sibling like `<root>/models-evil`.
  if (dest !== kindDir && !dest.startsWith(kindDir + sep)) {
    throw new Error("path escapes the upload root");
  }
  return dest;
}

/**
 * Which of `files` still need uploading: any whose size on the host differs from
 * the client's (missing counts as differing). This is the "check the server for
 * a copy" step — a model already present in full is skipped. Pure; `sizeOf`
 * returns the host's size for a rel, or undefined when absent.
 */
export function computeNeed(
  files: { rel: string; size: number }[],
  sizeOf: (rel: string) => number | undefined,
): string[] {
  return files.filter((f) => sizeOf(f.rel) !== f.size).map((f) => f.rel);
}

/** Sizes of every file under `dir`, keyed by path relative to `dir` (POSIX
 *  separators). Empty when the directory does not exist yet. */
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

/**
 * Write one chunk of an upload at `offset`. The first chunk (offset 0) creates
 * or truncates the file, so a re-upload starts clean; later chunks write at
 * their position. Chunks arrive in order from a single client.
 */
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
