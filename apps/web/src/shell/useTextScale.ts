import { migrateStorageKey, STORAGE_NAMESPACE } from "@penumbra/shared";
import { useEffect } from "react";

// Every size is rem, so scaling the root font-size zooms the whole UI.

const STORAGE_KEY = `${STORAGE_NAMESPACE}.shell.text-scale.v1`;
/** Migrated so existing zoom levels survive. */
const LEGACY_STORAGE_KEY = "penumbra:text-scale";
export const MIN_SCALE = 0.7;
export const MAX_SCALE = 1.8;
const STEP = 0.1;

/** Rounds to whole percent so repeated steps don't drift. */
export function clampScale(scale: number): number {
  const rounded = Math.round(scale * 100) / 100;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, rounded));
}

/** "+"/"=", "-"/"_", "0": how the chord arrives across layouts and the numpad. */
export function scaleForKey(current: number, key: string): number | null {
  if (key === "+" || key === "=") return clampScale(current + STEP);
  if (key === "-" || key === "_") return clampScale(current - STEP);
  if (key === "0") return 1;
  return null;
}

/**
 * Guarded: localStorage throws where blocked, and this runs with no error
 * boundary above it.
 */
function read(): number {
  migrateStorageKey(LEGACY_STORAGE_KEY, STORAGE_KEY);
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampScale(raw) : 1;
  } catch {
    return 1;
  }
}

function remember(scale: number): void {
  try {
    if (scale === 1) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {}
}

function apply(scale: number): void {
  // Cleared at 1× rather than pinned at 100%, which would override browser zoom.
  const root = document.documentElement;
  if (scale === 1) root.style.removeProperty("font-size");
  // Rounded again: multiplying back up reintroduces float error (110.00000000000001%).
  else root.style.fontSize = `${Math.round(scale * 100)}%`;
}

export function useTextScale(): void {
  useEffect(() => {
    let scale = read();
    apply(scale);

    const onKey = (e: KeyboardEvent) => {
      // Not with Alt: a different gesture.
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const next = scaleForKey(scale, e.key);
      if (next === null) return;
      e.preventDefault();
      scale = next;
      apply(scale);
      remember(scale);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
