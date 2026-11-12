// A standalone `.gguf` is one model. A directory with `config.json` and
// trainable weights is one HF model, taken whole. A GGUF release folder also
// has a config.json but only quants, so each `.gguf` counts separately.

import { basename, type DirLister, walk } from "./scan";

export type { DirLister };

export type ModelKind = "gguf" | "hf";

export interface ModelEntry {
  kind: ModelKind;
  name: string;
  path: string;
  size: number | null;
}

const isGguf = (name: string): boolean => name.toLowerCase().endsWith(".gguf");

/** Shards match too. */
const isHfWeight = (name: string): boolean =>
  /\.(safetensors|bin|pt|pth)$/i.test(name);

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

      // See the header: a config.json with only `.gguf` weights is a quant release.
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
