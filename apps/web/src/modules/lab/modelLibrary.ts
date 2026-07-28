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
//
// A GGUF release folder looks like both: it ships a `config.json` alongside a
// dozen quants of the same weights. Taking it whole would offer the user one
// entry that is really 20 GB of alternatives — so weights decide. A directory is
// an HF model when it holds weights Unsloth can train from; a directory of
// `.gguf` files is that many separate models.

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

/** The weight files an HF model directory carries — safetensors today, torch
 *  pickles on older repos. Shards (`model-00001-of-00002.safetensors`) match. */
const isHfWeight = (name: string): boolean =>
  /\.(safetensors|bin|pt|pth)$/i.test(name);

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
      const files = listing.entries.filter((e) => !e.isDir);
      const hasConfig = files.some((e) => e.name === "config.json");
      const ggufs = files.filter((e) => isGguf(e.name));

      // A `config.json` marks this directory as one HF model: record it and
      // prune — its shards/snapshots are not separate models. Unless the only
      // weights here are `.gguf`, in which case it's a quant release and each
      // file stands alone (see the header).
      const hfWeights =
        ggufs.length === 0 || files.some((e) => isHfWeight(e.name));
      if (hasConfig && hfWeights) {
        found.set(listing.path, {
          kind: "hf",
          name: basename(listing.path),
          path: listing.path,
          size: null,
        });
        return false;
      }

      for (const entry of ggufs) {
        found.set(entry.path, {
          kind: "gguf",
          name: entry.name,
          path: entry.path,
          size: entry.size,
        });
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
