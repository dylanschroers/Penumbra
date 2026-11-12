// Desktop-only wrappers over the Tauri fs commands (src-tauri/src/fs.rs).
// Gate on `isFsAvailable`.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: number | null;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export const isFsAvailable =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** An empty path starts at the user's home dir. */
export function listDir(path = ""): Promise<Listing> {
  return invoke<Listing>("fs_list", { path });
}

/**
 * Resolves to the chosen path, or null if cancelled. Seeds a root only; the fs
 * commands are not scoped to it.
 */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    title: "Add folder",
  });
  return typeof picked === "string" ? picked : null;
}

/** Rejects on a name clash or moving a folder into itself (enforced in fs.rs). */
export async function moveEntry(from: string, toDir: string): Promise<string> {
  const { path } = await invoke<{ path: string }>("fs_move", { from, toDir });
  return path;
}

export interface FileHead {
  content: string;
  truncated: boolean;
}

/** `truncated` is false only when the whole file fit. */
export function readHead(path: string, maxBytes: number): Promise<FileHead> {
  return invoke<FileHead>("fs_read_head", { path, maxBytes });
}

/**
 * A short or empty result means end of file. Lets uploads stream without
 * holding the file in memory.
 */
export function readChunk(
  path: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("fs_read_chunk", { path, offset, length });
}
