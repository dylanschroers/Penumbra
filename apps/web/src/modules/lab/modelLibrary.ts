// Discovers the models the user keeps on this device, so the Model Lab can pick
// a base model by name instead of a hand-typed path. It walks a folder the user
// chose with the native picker (apps/web/src/fs/fsClient.ts) and classifies what
// it finds; the transfer to the Studio host is a later step.
//
// Two shapes count as a model:
//   - a standalone `.gguf` file — a quantized weight (export/inference artifact);
//   - a HuggingFace model *directory* — a folder holding a `config.json`, the
//     format Unsloth fine-tunes *from*. Its children are shards/snapshots, not
//     more models, so a matched directory is taken whole and not descended into.

import { basename, type DirLister, walk } from "./scan";

export type { DirLister };

export type ModelKind = "gguf" | "hf";

export interface ModelEntry {
  kind: ModelKind;
  /** Display name: the file name for a gguf, the directory name for an hf model. */
  name: string;
  /** Absolute path — the `.gguf` file, or the HF model directory. */
  path: string;
  /** Bytes for a gguf file; null for an hf directory. */
  size: number | null;
}

const isGguf = (name: string): boolean => name.toLowerCase().endsWith(".gguf");

/**
 * Walk `root` and collect the models beneath it, de-duplicated by absolute path
 * and sorted by kind then name.
 */
export async function scanModels(
  root: string,
  list?: DirLister,
  maxDepth?: number,
): Promise<ModelEntry[]> {
  const found = new Map<string, ModelEntry>();

  await walk(
    root,
    (listing) => {
      // A `config.json` marks this directory as one HF model: record it and
      // prune — its shards/snapshots are not separate models.
      if (listing.entries.some((e) => !e.isDir && e.name === "config.json")) {
        found.set(listing.path, {
          kind: "hf",
          name: basename(listing.path),
          path: listing.path,
          size: null,
        });
        return false;
      }

      for (const entry of listing.entries) {
        if (!entry.isDir && isGguf(entry.name)) {
          found.set(entry.path, {
            kind: "gguf",
            name: entry.name,
            path: entry.path,
            size: entry.size,
          });
        }
      }
      return true;
    },
    list,
    maxDepth,
  );

  return [...found.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
}
