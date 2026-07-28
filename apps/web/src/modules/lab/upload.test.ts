import { beforeEach, describe, expect, it, vi } from "vitest";

const listDir = vi.fn();
const readChunk = vi.fn();
vi.mock("../../fs/fsClient", () => ({ listDir, readChunk }));

const { uploadModel } = await import("./upload");

const target = { serverURL: "http://host" };

/** Serve a file of `size` bytes in whatever chunk lengths are asked for. */
function fileOfSize(size: number) {
  return async (_path: string, offset: number, length: number) =>
    new ArrayBuffer(Math.max(0, Math.min(length, size - offset)));
}

beforeEach(() => {
  listDir.mockReset();
  readChunk.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

describe("uploadModel — a standalone gguf", () => {
  it("sends the picked file alone, without listing its folder", async () => {
    // The folder around a quant holds a dozen more of the same weights; listing
    // it would upload all of them (and listing a *file* fails outright).
    readChunk.mockImplementation(fileOfSize(10));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ path: "/srv/models/Qwen3-1.7B-Q8_0.gguf" }),
    } as Response);

    const path = await uploadModel(
      target,
      "F:\\modelStorage\\Qwen3-1.7B-GGUF\\Qwen3-1.7B-Q8_0.gguf",
    );

    expect(path).toBe("/srv/models/Qwen3-1.7B-Q8_0.gguf");
    expect(listDir).not.toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes("/lab/upload?kind=models"))).toBe(true);
    expect(urls[0]).toContain(
      `rel=${encodeURIComponent("Qwen3-1.7B-Q8_0.gguf")}`,
    );
  });
});

describe("uploadModel — errors", () => {
  it("turns a full-disk refusal into a message that says so", async () => {
    readChunk.mockImplementation(fileOfSize(10));
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 507,
      json: async () => ({
        error: "insufficient_space",
        need: 2 * 1024 ** 3,
        free: 1024 ** 3,
      }),
    } as Response);

    await expect(
      uploadModel(target, "F:\\modelStorage\\big.gguf"),
    ).rejects.toThrow(/out of disk space \(needs 2\.0 GB, 1\.0 GB free\)/);
  });

  it("falls back to the status when the server sends no reason", async () => {
    readChunk.mockImplementation(fileOfSize(10));
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await expect(
      uploadModel(target, "F:\\modelStorage\\big.gguf"),
    ).rejects.toThrow(/server responded 502/);
  });
});
