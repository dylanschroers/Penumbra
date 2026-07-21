import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEngine } from "./LocalEngine";

// The OpenAI protocol loop is tested once, in @penumbra/shared's OpenAiEngine
// tests. LocalEngine only supplies Tier-0 configuration, so that is all this
// file checks.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const bindings = { tools: [], system: "sys", runTool: vi.fn() };

beforeEach(() => mockFetch.mockReset());

describe("LocalEngine", () => {
  it("defaults to the bundled llama-server address", async () => {
    mockFetch.mockResolvedValueOnce(res({ data: [] }));
    await new LocalEngine({ bindings }).getStatus();
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8080/v1/models",
    );
  });

  it("accepts an explicit address and model", async () => {
    mockFetch.mockResolvedValueOnce(res({ data: [] }));
    await new LocalEngine({
      bindings,
      baseURL: "http://elsewhere:9000",
      model: "m",
    }).getStatus();
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://elsewhere:9000/v1/models",
    );
  });

  it("names itself in model errors", async () => {
    mockFetch.mockResolvedValue(res({}, false, 500));
    const gen = new LocalEngine({ bindings }).runAgent([
      { role: "user", content: "x" },
    ]);
    await expect(gen.next()).rejects.toThrow("local model responded 500");
  });
});
