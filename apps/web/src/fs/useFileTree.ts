import { useCallback, useEffect, useState } from "react";
import {
  type DirEntry,
  isFsAvailable,
  listDir,
  moveEntry,
  pickFolder,
} from "./fsClient";

// Owns the file sidebar's state: the set of imported root folders and, for each
// expanded directory, its lazily-loaded children. Roots are the only thing that
// persists (to localStorage — the same prototype-era choice the workspace layout
// makes); everything else is rebuilt on demand from disk, so nothing here can go
// stale against the real filesystem for long.
//
// Desktop-only. On the web build isFsAvailable is false and every action no-ops,
// so the component can render a placeholder without special-casing the hook.

const ROOTS_KEY = "penumbra.fs.roots";

function loadRoots(): string[] {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

/** Parent directory of a path (handles both separators; no trailing slash). */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

export interface FileTree {
  available: boolean;
  roots: string[];
  /** Directories the user has expanded. */
  expanded: Set<string>;
  /** Cached children per directory path (present once loaded). */
  children: Record<string, DirEntry[]>;
  /** Per-path load error, keyed by directory path. */
  errors: Record<string, string>;
  /** Directories with an in-flight listing. */
  loading: Set<string>;
  addRoot: () => Promise<void>;
  removeRoot: (path: string) => void;
  toggle: (path: string) => void;
  move: (from: string, toDir: string) => Promise<void>;
}

export function useFileTree(): FileTree {
  const [roots, setRoots] = useState<string[]>(() =>
    isFsAvailable ? loadRoots() : [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());

  // Persist the root list whenever it changes.
  useEffect(() => {
    if (!isFsAvailable) return;
    try {
      localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
    } catch {
      // Non-fatal: the roots just won't survive a reload.
    }
  }, [roots]);

  const markLoading = useCallback((path: string, on: boolean) => {
    setLoading((prev) => {
      const next = new Set(prev);
      on ? next.add(path) : next.delete(path);
      return next;
    });
  }, []);

  // Load (or reload) one directory into the children cache.
  const load = useCallback(
    async (path: string) => {
      markLoading(path, true);
      setErrors((prev) => {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      try {
        const listing = await listDir(path);
        setChildren((prev) => ({ ...prev, [path]: listing.entries }));
      } catch (err) {
        setErrors((prev) => ({ ...prev, [path]: String(err) }));
      } finally {
        markLoading(path, false);
      }
    },
    [markLoading],
  );

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // Load on first expand; keep the cache on subsequent toggles.
          if (!(path in children)) void load(path);
        }
        return next;
      });
    },
    [children, load],
  );

  const addRoot = useCallback(async () => {
    if (!isFsAvailable) return;
    const picked = await pickFolder();
    if (!picked) return;
    setRoots((prev) => (prev.includes(picked) ? prev : [...prev, picked]));
  }, []);

  const removeRoot = useCallback((path: string) => {
    // Drop the root and any cached/expanded state beneath it.
    setRoots((prev) => prev.filter((r) => r !== path));
    const under = (p: string) =>
      p === path || p.startsWith(`${path}/`) || p.startsWith(`${path}\\`);
    setExpanded((prev) => new Set([...prev].filter((p) => !under(p))));
    setChildren((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([p]) => !under(p))),
    );
    setErrors((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([p]) => !under(p))),
    );
  }, []);

  const move = useCallback(
    async (from: string, toDir: string) => {
      await moveEntry(from, toDir);
      // Refresh both ends of the move if they're currently shown.
      const src = parentDir(from);
      if (src in children) await load(src);
      if (toDir in children) await load(toDir);
    },
    [children, load],
  );

  return {
    available: isFsAvailable,
    roots,
    expanded,
    children,
    errors,
    loading,
    addRoot,
    removeRoot,
    toggle,
    move,
  };
}
