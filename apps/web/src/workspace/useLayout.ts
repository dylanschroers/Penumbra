import { useCallback, useEffect, useState } from "react";
import type { ModuleInstance } from "./types";
import { getModule } from "./registry";

// Workspace layout is user-authored data (Plane A in docs/ARCHITECTURE.md).
// It will eventually live in the shared SQLite schema and sync across devices;
// for now it's persisted to localStorage, which keeps this hook's *interface*
// identical to what a SQLite-backed version would expose, so swapping the
// storage later doesn't touch the canvas.
// Bump the version suffix whenever the grid's unit system changes (e.g. column
// count), so layouts saved in the old units are discarded instead of rendering
// at the wrong size. v2: grid widened from 12 to 24 columns.
const STORAGE_KEY = "ghost.workspace.layout.v2";

function load(): ModuleInstance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Drop anything that isn't an array or references a module no longer in the
    // registry, so a renamed/removed module can't wedge the whole canvas.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is ModuleInstance =>
        i && typeof i.instanceId === "string" && !!getModule(i.moduleId),
    );
  } catch {
    return [];
  }
}

export function useLayout() {
  const [instances, setInstances] = useState<ModuleInstance[]>(load);

  // Persist on every change. localStorage is synchronous and tiny here, so a
  // plain write-through is enough — no debounce needed.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(instances));
    } catch {
      // Ignore quota/serialization errors: the in-memory layout still works.
    }
  }, [instances]);

  /** Add a module instance below everything already placed. */
  const addModule = useCallback((moduleId: string) => {
    const def = getModule(moduleId);
    if (!def) return;
    setInstances((prev) => {
      // No compaction is applied, so a new module would otherwise land on top of
      // existing ones at (0,0). Drop it in a fresh row beneath the lowest module.
      const nextY = prev.reduce((max, i) => Math.max(max, i.y + i.h), 0);
      return [
        ...prev,
        {
          instanceId: crypto.randomUUID(),
          moduleId,
          x: 0,
          y: nextY,
          w: def.defaultSize.w,
          h: def.defaultSize.h,
        },
      ];
    });
  }, []);

  /** Remove one placed instance. */
  const removeModule = useCallback((instanceId: string) => {
    setInstances((prev) => prev.filter((i) => i.instanceId !== instanceId));
  }, []);

  /** Replace positions/sizes after a drag or resize. */
  const applyLayout = useCallback(
    (next: { i: string; x: number; y: number; w: number; h: number }[]) => {
      setInstances((prev) =>
        prev.map((inst) => {
          const item = next.find((n) => n.i === inst.instanceId);
          return item
            ? { ...inst, x: item.x, y: item.y, w: item.w, h: item.h }
            : inst;
        }),
      );
    },
    [],
  );

  return { instances, addModule, removeModule, applyLayout };
}
