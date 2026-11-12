import { type Listing, listDir } from "../../fs/fsClient";

export type DirLister = (path: string) => Promise<Listing>;

// Bounded so picking a huge tree (or `/`) can't hang the UI.
export const DEFAULT_MAX_DEPTH = 4;
const MAX_DIRS = 500;

export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * Breadth-first within depth and directory budgets. `visit` returns false to
 * prune. Unreadable dirs are skipped; hidden dirs are never descended.
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
