import { describe, expect, it } from "vitest";
import type { Listing } from "../../fs/fsClient";
import { type DirLister, scanModels } from "./modelLibrary";

// Missing paths throw, standing in for unreadable directories.
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

describe("scanModels", () => {
  it("finds gguf files at any depth", async () => {
    const fs = fakeFs({
      "/models": [
        ["a.gguf", false, 1000],
        ["sub", true],
      ],
      "/models/sub": [["b.gguf", false, 2000]],
    });
    const models = await scanModels("/models", fs);
    expect(models.map((m) => m.name)).toEqual(["a.gguf", "b.gguf"]);
    expect(models.every((m) => m.kind === "gguf")).toBe(true);
    expect(models[0]?.size).toBe(1000);
  });

  it("treats a directory with config.json as one HF model and stops there", async () => {
    const fs = fakeFs({
      "/models": [["Llama-3.2-1B", true]],
      "/models/Llama-3.2-1B": [
        ["config.json", false, 500],
        ["model.safetensors", false, 9_000_000_000],
        ["shard", true],
      ],
      "/models/Llama-3.2-1B/shard": [["extra.gguf", false, 42]],
    });
    const models = await scanModels("/models", fs);
    expect(models).toEqual([
      {
        kind: "hf",
        name: "Llama-3.2-1B",
        path: "/models/Llama-3.2-1B",
        size: null,
      },
    ]);
  });

  it("lists a gguf release folder as its individual quants, not one model", async () => {
    // GGUF repos ship a config.json beside every quant.
    const fs = fakeFs({
      "/models": [["Qwen3-1.7B-GGUF", true]],
      "/models/Qwen3-1.7B-GGUF": [
        ["config.json", false, 500],
        ["Qwen3-1.7B-Q8_0.gguf", false, 1_800_000_000],
        ["Qwen3-1.7B-Q4_K_M.gguf", false, 1_100_000_000],
      ],
    });
    const models = await scanModels("/models", fs);
    expect(models.map((m) => `${m.kind}:${m.name}`)).toEqual([
      "gguf:Qwen3-1.7B-Q4_K_M.gguf",
      "gguf:Qwen3-1.7B-Q8_0.gguf",
    ]);
  });

  it("prefers the HF model when a dir holds both real weights and a gguf", async () => {
    const fs = fakeFs({
      "/models": [["Llama", true]],
      "/models/Llama": [
        ["config.json", false, 1],
        ["model.safetensors", false, 100],
        ["export.gguf", false, 50],
      ],
    });
    const models = await scanModels("/models", fs);
    expect(models.map((m) => `${m.kind}:${m.name}`)).toEqual(["hf:Llama"]);
  });

  it("skips hidden directories", async () => {
    const fs = fakeFs({
      "/models": [
        [".cache", true],
        ["real.gguf", false, 10],
      ],
      "/models/.cache": [["hidden.gguf", false, 20]],
    });
    const models = await scanModels("/models", fs);
    expect(models.map((m) => m.name)).toEqual(["real.gguf"]);
  });

  it("stops descending past the depth limit", async () => {
    const fs = fakeFs({
      "/r": [["d1", true]],
      "/r/d1": [["d2", true]],
      "/r/d1/d2": [["deep.gguf", false, 1]],
    });
    expect(await scanModels("/r", fs, 1)).toEqual([]);
    expect((await scanModels("/r", fs, 2)).map((m) => m.name)).toEqual([
      "deep.gguf",
    ]);
  });

  it("skips unreadable directories without failing the scan", async () => {
    const fs = fakeFs({
      "/models": [
        ["locked", true],
        ["ok.gguf", false, 1],
      ],
    });
    const models = await scanModels("/models", fs);
    expect(models.map((m) => m.name)).toEqual(["ok.gguf"]);
  });

  it("de-duplicates and sorts by kind then name", async () => {
    const fs = fakeFs({
      "/m": [
        ["z.gguf", false, 1],
        ["a.gguf", false, 1],
        ["hf", true],
      ],
      "/m/hf": [["config.json", false, 1]],
    });
    const models = await scanModels("/m", fs);
    expect(models.map((m) => `${m.kind}:${m.name}`)).toEqual([
      "gguf:a.gguf",
      "gguf:z.gguf",
      "hf:hf",
    ]);
  });
});
