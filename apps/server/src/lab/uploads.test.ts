import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeNeed,
  dirFileSizes,
  freeSpace,
  isOutOfSpace,
  resolveDest,
  writeChunk,
} from "./uploads";

describe("resolveDest — path safety", () => {
  const root = "/srv/uploads";

  it("resolves a normal relative path under the kind dir", () => {
    expect(resolveDest(root, "datasets", "train.jsonl")).toBe(
      "/srv/uploads/datasets/train.jsonl",
    );
    expect(resolveDest(root, "models", "Qwen/model.safetensors")).toBe(
      "/srv/uploads/models/Qwen/model.safetensors",
    );
  });

  it("rejects traversal out of the kind dir", () => {
    expect(() => resolveDest(root, "models", "../datasets/x")).toThrow();
    expect(() => resolveDest(root, "models", "../../etc/passwd")).toThrow();
    expect(() => resolveDest(root, "models", "a/../../b")).toThrow();
  });

  it("rejects absolute rels and unknown kinds", () => {
    expect(() => resolveDest(root, "datasets", "/etc/passwd")).toThrow();
    expect(() => resolveDest(root, "secrets", "x")).toThrow();
    expect(() => resolveDest(root, "datasets", "")).toThrow();
  });

  it("rejects a sibling dir that shares the kind prefix", () => {
    // Would resolve to /srv/uploads/models-evil without the separator guard.
    expect(() => resolveDest(root, "models", "../models-evil/x")).toThrow();
  });
});

describe("computeNeed", () => {
  it("returns files whose host size differs or is missing", () => {
    const files = [
      { rel: "config.json", size: 100 },
      { rel: "model.safetensors", size: 999 },
      { rel: "tokenizer.json", size: 50 },
    ];
    const host: Record<string, number> = {
      "config.json": 100, // present, same → skip
      "model.safetensors": 12, // present, different → need
      // tokenizer.json missing → need
    };
    expect(computeNeed(files, (rel) => host[rel])).toEqual([
      "model.safetensors",
      "tokenizer.json",
    ]);
  });
});

describe("writeChunk + dirFileSizes", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "penumbra-upload-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("assembles a file from ordered chunks and creates parent dirs", async () => {
    const dest = resolveDest(root, "models", "m/model.bin");
    await writeChunk(dest, 0, Buffer.from("hello "));
    await writeChunk(dest, 6, Buffer.from("world"));
    expect(await readFile(dest, "utf8")).toBe("hello world");

    const sizes = await dirFileSizes(join(root, "models", "m"));
    expect(sizes["model.bin"]).toBe(11);
  });

  it("truncates on a fresh offset-0 write (re-upload starts clean)", async () => {
    const dest = resolveDest(root, "datasets", "d.jsonl");
    await writeChunk(dest, 0, Buffer.from("aaaaaaaa"));
    await writeChunk(dest, 0, Buffer.from("bb"));
    expect(await readFile(dest, "utf8")).toBe("bb");
  });

  it("returns an empty map for a missing directory", async () => {
    expect(await dirFileSizes(join(root, "nope"))).toEqual({});
  });
});

describe("freeSpace", () => {
  it("reports the volume's free bytes", async () => {
    const free = await freeSpace(tmpdir());
    expect(free).toBeGreaterThan(0);
    expect(Number.isFinite(free)).toBe(true);
  });

  it("measures the nearest existing ancestor of a not-yet-created root", async () => {
    // The upload root is created lazily on the first chunk, so the preflight has
    // to work before it exists. A real figure (not the Infinity that means
    // "couldn't measure") proves it walked up to a path that does exist —
    // asserting the exact number would only test how busy the disk is.
    const nested = join(tmpdir(), "penumbra-absent", "uploads", "models");
    const free = await freeSpace(nested);
    expect(Number.isFinite(free)).toBe(true);
    expect(free).toBeGreaterThan(0);
  });
});

describe("isOutOfSpace", () => {
  it("recognizes ENOSPC and nothing else", () => {
    expect(
      isOutOfSpace(Object.assign(new Error("x"), { code: "ENOSPC" })),
    ).toBe(true);
    expect(
      isOutOfSpace(Object.assign(new Error("x"), { code: "EACCES" })),
    ).toBe(false);
    expect(isOutOfSpace(new Error("x"))).toBe(false);
    expect(isOutOfSpace(null)).toBe(false);
  });
});
