import { migrateStorageKey, STORAGE_NAMESPACE } from "@penumbra/shared";

// The folders imported into the sidebar. The sidebar edits them; the agent's
// file tools read them per call, so a folder added or removed mid-chat takes
// effect on the next tool call.

export const ROOTS_KEY = `${STORAGE_NAMESPACE}.fs.roots.v1`;
const LEGACY_ROOTS_KEY = "penumbra.fs.roots";

export function loadRoots(): string[] {
  migrateStorageKey(LEGACY_ROOTS_KEY, ROOTS_KEY);
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

/** Fired on window after the agent changes files, with the touched paths, so
 *  the sidebar can reload the folders that hold them. */
export const FS_CHANGED_EVENT = "penumbra:fs-changed";

export function notifyFsChanged(paths: string[]): void {
  window.dispatchEvent(
    new CustomEvent<string[]>(FS_CHANGED_EVENT, { detail: paths }),
  );
}
