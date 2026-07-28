// Shared, bounded directory walk for the Model Lab's on-device libraries (models
// and datasets). Both scanners work the same way — descend a folder the user
// picked, look at each directory's entries — and differ only in what they
// collect, so the traversal lives here once.

import { type Listing, listDir } from "../../fs/fsClient";

/** A directory lister with fsClient.listDir's contract, injectable so scans can
 *  be tested without a live filesystem. */
export type DirLister = (path: string) => Promise<Listing>;

// The walk is bounded so a mistaken pick of a huge tree (or `/`) can't hang the
// UI: models and datasets rarely nest deep, and a few hundred directories covers
// a dedicated folder or a HuggingFace cache.
export const DEFAULT_MAX_DEPTH = 4;
const MAX_DIRS = 500;

/** Last path segment, tolerant of both `/` and `\` separators. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * Walk `root` breadth-first within a depth and directory-count budget, calling
 * `visit` for every readable directory. Return `false` from `visit` to prune the
 * branch (e.g. an HF model dir whose children are shards, not more models).
 *
 * Unreadable directories (permissions, races) are skipped rather than failing
 * the whole walk; hidden directories (`.git`, caches) are never descended into.
 */
export async function walk(
  root: string,
  visit: (listing: Listing, depth: number) => boolean,
  list: DirLister = listDir,
  maxDepth = DEFAULT_MAX_DEPTH,
): Promise<void> {
  const stack: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_DIRS) {
    const item = stack.pop();
    if (!item) break;
    visited++;

    let listing: Listing;
    try {
      listing = await list(item.path);
    } catch {
      continue; // unreadable — skip this branch, keep walking the rest
    }

    const descend = visit(listing, item.depth);
    if (!descend || item.depth >= maxDepth) continue;

    for (const entry of listing.entries) {
      if (entry.isDir && !entry.name.startsWith(".")) {
        stack.push({ path: entry.path, depth: item.depth + 1 });
      }
    }
  }
}
