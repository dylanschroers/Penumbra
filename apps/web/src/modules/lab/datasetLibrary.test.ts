import { describe, expect, it } from "vitest";
import type { Listing } from "../../fs/fsClient";
import { type DirLister, scanDatasets } from "./datasetLibrary";

// A tiny in-memory filesystem: map each directory path to its entries as
// [name, isDir, size?] tuples. Missing paths throw, standing in for an
// unreadable directory.
type Node = [name: string, isDir: boolean, size?: number];

function fakeFs(tree: Record<string, Node[]>): DirLister {
  return async (path: string): Promise<Listing> => {
    const entries = tree[path];
    if (!entries) throw new Error(`ENOENT: ${path}`);
    return {
      path,
      parent: null,
      entries: entries.map(([name, isDir, size]) => ({
        name,
        path: `${path}/${name}`,
        isDir,
        size: isDir ? null : (size ?? 0),
        modified: null,
      })),
    };
  };
}

describe("scanDatasets", () => {
  it("collects the recognised data formats at any depth", async () => {
    const fs = fakeFs({
      "/data": [
        ["train.jsonl", false, 100],
        ["notes.txt", false, 5], // ignored — not a data format
        ["sub", true],
      ],
      "/data/sub": [
        ["eval.csv", false, 200],
        ["shard.parquet", false, 300],
        ["config.json", false, 10],
      ],
    });
    const found = await scanDatasets("/data", fs);
    expect(found.map((d) => `${d.format}:${d.name}`)).toEqual([
      "json:config.json",
      "csv:eval.csv",
      "parquet:shard.parquet",
      "jsonl:train.jsonl",
    ]);
    expect(found.find((d) => d.name === "train.jsonl")?.size).toBe(100);
  });

  it("ignores non-data files", async () => {
    const fs = fakeFs({
      "/d": [
        ["readme.md", false, 1],
        ["model.safetensors", false, 999],
        ["a.jsonl", false, 1],
      ],
    });
    const found = await scanDatasets("/d", fs);
    expect(found.map((d) => d.name)).toEqual(["a.jsonl"]);
  });

  it("skips hidden directories and unreadable branches", async () => {
    const fs = fakeFs({
      "/d": [
        [".cache", true],
        ["locked", true],
        ["real.jsonl", false, 1],
      ],
      "/d/.cache": [["hidden.jsonl", false, 1]],
      // "/d/locked" is intentionally absent → throws when listed.
    });
    const found = await scanDatasets("/d", fs);
    expect(found.map((d) => d.name)).toEqual(["real.jsonl"]);
  });

  it("stops descending past the depth limit", async () => {
    const fs = fakeFs({
      "/r": [["d1", true]],
      "/r/d1": [["d2", true]],
      "/r/d1/d2": [["deep.jsonl", false, 1]],
    });
    expect(await scanDatasets("/r", fs, 1)).toEqual([]);
    expect((await scanDatasets("/r", fs, 2)).map((d) => d.name)).toEqual([
      "deep.jsonl",
    ]);
  });
});
