// Discovers the fine-tuning datasets the user keeps on this device, so the Model
// Lab can pick a training file by name instead of a hand-typed path. It walks a
// folder chosen with the native picker (apps/web/src/fs/fsClient.ts) and collects
// the data files it finds; sending the file to the Studio host is a later step.
//
// A dataset here is a *file* in one of the shapes Studio ingests — the same
// extensions LabModule's toDatasetSource treats as local data:
//   - `.jsonl` — one JSON record per line; the usual fine-tuning format.
//   - `.json`  — a single JSON array of records.
//   - `.csv`   — columnar (e.g. instruction/output columns).
//   - `.parquet` — columnar binary, how HuggingFace ships most datasets.

import { type DirLister, walk } from "./scan";

export type { DirLister };

export type DatasetFormat = "jsonl" | "json" | "csv" | "parquet";

export interface DatasetEntry {
  format: DatasetFormat;
  /** File name, e.g. `alpaca-train.jsonl`. */
  name: string;
  /** Absolute path to the data file. */
  path: string;
  /** Bytes. */
  size: number | null;
}

const DATASET_RE = /\.(jsonl|json|csv|parquet)$/i;

/** The dataset format a file name implies, or null if it isn't a data file. */
export function datasetFormat(name: string): DatasetFormat | null {
  const ext = name.match(DATASET_RE)?.[1];
  return ext ? (ext.toLowerCase() as DatasetFormat) : null;
}

/**
 * Walk `root` and collect the dataset files beneath it, de-duplicated by
 * absolute path and sorted by name.
 */
export async function scanDatasets(
  root: string,
  list?: DirLister,
  maxDepth?: number,
): Promise<DatasetEntry[]> {
  const found = new Map<string, DatasetEntry>();

  await walk(
    root,
    (listing) => {
      for (const entry of listing.entries) {
        if (entry.isDir) continue;
        const format = datasetFormat(entry.name);
        if (format) {
          found.set(entry.path, {
            format,
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

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
