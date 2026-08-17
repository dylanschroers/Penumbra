import { migrateStorageKey, STORAGE_NAMESPACE } from "@penumbra/shared";
import { useEffect } from "react";

// UI text scale, driven by Ctrl/Cmd +/-/0. Every size in the app is a rem, so
// nudging the root font-size scales the whole interface together — the chat
// included — which is what "zoom the text" means here, and why it needs no
// per-rule changes. The factor is written as a percentage on <html> (100% is
// the initial 16px) and persisted so a reload keeps it.

const STORAGE_KEY = `${STORAGE_NAMESPACE}.shell.text-scale.v1`;
/** The key this shipped under before it joined the namespace every other
 *  setting uses. Migrated rather than dropped: someone who has zoomed keeps
 *  their zoom. */
const LEGACY_STORAGE_KEY = "penumbra:text-scale";
export const MIN_SCALE = 0.7;
export const MAX_SCALE = 1.8;
const STEP = 0.1;

/** Round to whole percent and hold inside the range, so repeated steps neither
 *  drift on float error nor run past the bounds. */
export function clampScale(scale: number): number {
  const rounded = Math.round(scale * 100) / 100;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, rounded));
}

/** The scale a key press asks for, or null when the press isn't a zoom gesture.
 *  "+"/"=" grow, "-"/"_" shrink, "0" resets — the spellings a +/-/0 chord can
 *  arrive as across keyboard layouts and the numpad. */
export function scaleForKey(current: number, key: string): number | null {
  if (key === "+" || key === "=") return clampScale(current + STEP);
  if (key === "-" || key === "_") return clampScale(current - STEP);
  if (key === "0") return 1;
  return null;
}

/**
 * The stored scale, or 1× when there is none to read.
 *
 * Guarded like every other reader in the app: `localStorage` *throws* rather
 * than returning null where storage is blocked (a locked-down webview, Safari
 * private browsing), and this runs from App's first effect with no error
 * boundary above it — an unguarded throw there blanks the whole app over a
 * zoom preference.
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

/** Persist the scale, or forget it at 1× so the stylesheet default stands. */
function remember(scale: number): void {
  try {
    if (scale === 1) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // Non-fatal: the zoom just won't survive a reload.
  }
}

function apply(scale: number): void {
  // Cleared at 1× so the stylesheet default stands, rather than pinning an
  // explicit 100% that would also override a user's own browser zoom.
  const root = document.documentElement;
  if (scale === 1) root.style.removeProperty("font-size");
  // Rounded again on the way out. clampScale rounds the *factor* to whole
  // percent, but multiplying it back up re-introduces the float error it just
  // removed: one step from 1× wrote `font-size: 110.00000000000001%`.
  else root.style.fontSize = `${Math.round(scale * 100)}%`;
}

export function useTextScale(): void {
  useEffect(() => {
    let scale = read();
    apply(scale);

    const onKey = (e: KeyboardEvent) => {
      // Only the Ctrl/Cmd chord, and not with Alt (a different gesture).
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const next = scaleForKey(scale, e.key);
      if (next === null) return;
      // Keep the browser/webview's own zoom from firing on the same chord.
      e.preventDefault();
      scale = next;
      apply(scale);
      remember(scale);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
