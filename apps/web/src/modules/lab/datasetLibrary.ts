// Scans a picked folder for dataset files Studio ingests (.jsonl, .json,
// .csv, .parquet).

import { type DirLister, walk } from "./scan";

export type { DirLister };

export type DatasetFormat = "jsonl" | "json" | "csv" | "parquet";

export interface DatasetEntry {
  format: DatasetFormat;
  name: string;
  path: string;
  size: number | null;
}

const DATASET_RE = /\.(jsonl|json|csv|parquet)$/i;

export function datasetFormat(name: string): DatasetFormat | null {
  const ext = name.match(DATASET_RE)?.[1];
  return ext ? (ext.toLowerCase() as DatasetFormat) : null;
}

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
