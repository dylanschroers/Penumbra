// What the shell reopens with: which modules are in the dock, and which one is
// expanded in the centre.
//
// The grid canvas persisted its layout, and nothing replaced that when the grid
// went — every reload came up with an empty dock and the user re-added the same
// modules by hand.
//
// Both fields live under one key because they are read and written together and
// two keys could drift apart: a focus restored onto a module that isn't open
// would leave the centre showing something the dock never mounted.

import { STORAGE_NAMESPACE } from "@penumbra/shared";

export const SESSION_KEY = `${STORAGE_NAMESPACE}.shell.session.v1`;

export interface ShellSession {
  open: string[];
  focused: string | null;
}

const EMPTY: ShellSession = { open: [], focused: null };

/**
 * Read the stored session, keeping only what still makes sense.
 *
 * `allowedIds` is the registry's current dock-able set, and ids are checked
 * against it rather than trusted: a module since renamed or dropped would
 * otherwise come back as a dock card for something that no longer exists, and
 * `getModule` would return undefined for it every render thereafter.
 */
export function loadSession(allowedIds: readonly string[]): ShellSession {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    const open: string[] = Array.isArray(parsed?.open)
      ? parsed.open.filter(
          (id: unknown) => typeof id === "string" && allowedIds.includes(id),
        )
      : [];
    // Focus has to name something in the open set — including after the filter
    // above, so a focused module that was dropped from the registry doesn't
    // survive as a focus onto nothing.
    const focused =
      typeof parsed?.focused === "string" && open.includes(parsed.focused)
        ? parsed.focused
        : null;
    return { open, focused };
  } catch {
    // Unavailable (SSR/tests) or corrupt — start empty, as the shell did before
    // it persisted anything.
    return EMPTY;
  }
}

/** Write the session back. Silent on failure: a workspace that doesn't survive
 *  the reload is worth less than one that takes the app down with it. */
export function saveSession(session: ShellSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Non-fatal.
  }
}
