// Desktop-only filesystem access for the file-manager sidebar. Thin wrappers
// over the native `fs_list` command (apps/desktop/src-tauri/src/fs.rs), reached
// through the same Tauri IPC `invoke` the db layer uses (src/db/tauriExec.ts).
// On the web build there is no Tauri and no disk to browse, so callers must gate
// on `isFsAvailable` first — `listDir` would otherwise reject.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** One directory entry as returned by `fs_list`. */
export interface DirEntry {
  name: string;
  /** Absolute path — pass straight back to `listDir` to descend. */
  path: string;
  isDir: boolean;
  /** Bytes; null for directories. */
  size: number | null;
  /** Modified time in ms since the epoch; null when unavailable. */
  modified: number | null;
}

/** A directory listing: the resolved dir, its parent (null at a root), entries. */
export interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

// Injected into every Tauri v2 webview; absent in ordinary browsers. Mirrors the
// `isTauri` probe in src/db/client.ts — the file browser only works on desktop.
export const isFsAvailable =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** List a directory. An empty path starts at the user's home dir. */
export function listDir(path = ""): Promise<Listing> {
  return invoke<Listing>("fs_list", { path });
}

/**
 * Open the OS folder picker so the user can bring a directory into the app.
 * Resolves to the chosen absolute path, or null if they cancelled. Once a folder
 * is imported, the fs commands can reach everything beneath it — the picker just
 * seeds a root; there's no per-path scoping.
 */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Add folder",
  });
  // With { multiple: false } this is a string | null, never an array.
  return typeof picked === "string" ? picked : null;
}

/**
 * Move `from` into the directory `toDir`, keeping its name. Resolves to the new
 * absolute path. Rejects if the destination already has an entry of that name or
 * if it would move a folder into itself (enforced natively in fs.rs).
 */
export async function moveEntry(from: string, toDir: string): Promise<string> {
  const { path } = await invoke<{ path: string }>("fs_move", { from, toDir });
  return path;
}

/** The head of a file plus whether more follows it. */
export interface FileHead {
  content: string;
  /** True when the file is larger than the bytes returned. */
  truncated: boolean;
}

/**
 * Read up to `maxBytes` from the start of a file — enough to preview a dataset
 * without loading a multi-gigabyte file. `truncated` is false only when the
 * whole file fit, so a caller can tell an exact record count from a sampled one.
 */
export function readHead(path: string, maxBytes: number): Promise<FileHead> {
  return invoke<FileHead>("fs_read_head", { path, maxBytes });
}
