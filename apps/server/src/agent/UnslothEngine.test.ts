import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnslothEngine } from "./UnslothEngine";

// The OpenAI protocol loop is tested once, in @ghost/shared's OpenAiEngine
// tests. UnslothEngine only resolves Tier-1 configuration — address, model,
// credentials — so that is all this file checks.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const bindings = { tools: [], system: "sys", runTool: vi.fn() };

/** Probe once and hand back the fetch arguments it produced. */
async function probe(engine: UnslothEngine) {
  mockFetch.mockResolvedValueOnce(res({ data: [] }));
  await engine.getStatus();
  const [url, init] = mockFetch.mock.calls[0] ?? [];
  return { url, headers: (init?.headers ?? {}) as Record<string, string> };
}

beforeEach(() => mockFetch.mockReset());

describe("UnslothEngine", () => {
  it("defaults to Studio's address when the environment is empty", async () => {
    const { url } = await probe(new UnslothEngine({ bindings, env: {} }));
    expect(url).toBe("http://127.0.0.1:8888/v1/models");
  });

  it("reads address, model, and key from the environment", async () => {
    const engine = new UnslothEngine({
      bindings,
      env: {
        UNSLOTH_BASE_URL: "http://gpu-host:8888",
        UNSLOTH_MODEL: "gpt-oss-20b",
        UNSLOTH_API_KEY: "sk-unsloth-abc",
      },
    });
    const { url, headers } = await probe(engine);

    expect(url).toBe("http://gpu-host:8888/v1/models");
    expect(headers.Authorization).toBe("Bearer sk-unsloth-abc");

    mockFetch.mockResolvedValueOnce(
      res({ choices: [{ message: { content: "hi" } }] }),
    );
    await engine.runAgent([{ role: "user", content: "x" }]).next();
    const body = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string);
    expect(body.model).toBe("gpt-oss-20b");
  });

  it("prefers explicit config over the environment", async () => {
    const { url, headers } = await probe(
      new UnslothEngine({
        bindings,
        baseURL: "http://explicit:9000",
        apiKey: "sk-explicit",
        env: {
          UNSLOTH_BASE_URL: "http://from-env:8888",
          UNSLOTH_API_KEY: "sk-from-env",
        },
      }),
    );
    expect(url).toBe("http://explicit:9000/v1/models");
    expect(headers.Authorization).toBe("Bearer sk-explicit");
  });

  // A Studio instance on a trusted LAN can run without a key. Sending an empty
  // bearer would be rejected as malformed, so the header must be absent.
  it("omits the Authorization header when no key is configured", async () => {
    const { headers } = await probe(new UnslothEngine({ bindings, env: {} }));
    expect(headers.Authorization).toBeUndefined();
  });

  it("allows more tool steps than the Tier-0 default", async () => {
    // The model asks for a tool forever; the loop stops at Tier 1's budget.
    const runTool = vi.fn().mockResolvedValue("ok");
    mockFetch.mockResolvedValue(
      res({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                { id: "c1", function: { name: "list_tasks", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    );

    const engine = new UnslothEngine({
      bindings: { tools: [], system: "sys", runTool },
      env: {},
    });
    for await (const _ of engine.runAgent([{ role: "user", content: "x" }]));
    expect(runTool).toHaveBeenCalledTimes(8);
  });
});
