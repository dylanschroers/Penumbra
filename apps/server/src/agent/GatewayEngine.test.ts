import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayEngine, gatewayConfigFromEnv } from "./GatewayEngine";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function res(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const bindings = { tools: [], system: "sys", runTool: vi.fn() };

beforeEach(() => mockFetch.mockReset());

describe("gatewayConfigFromEnv", () => {
  it("is off unless both the address and the route are set", () => {
    expect(gatewayConfigFromEnv({})).toBeUndefined();
    expect(
      gatewayConfigFromEnv({ PENUMBRA_GATEWAY_URL: "http://g:8090" }),
    ).toBeUndefined();
    expect(
      gatewayConfigFromEnv({ PENUMBRA_GATEWAY_MODEL: "route" }),
    ).toBeUndefined();
  });

  it("reads the gateway, defaulting the label and dropping an empty key", () => {
    expect(
      gatewayConfigFromEnv({
        PENUMBRA_GATEWAY_URL: " http://g:8090 ",
        PENUMBRA_GATEWAY_MODEL: "route",
        PENUMBRA_GATEWAY_KEY: "",
      }),
    ).toEqual({ baseURL: "http://g:8090", model: "route", label: "Gateway" });
  });
});

describe("GatewayEngine", () => {
  const engine = new GatewayEngine({
    bindings,
    baseURL: "http://g:8090",
    model: "route",
    apiKey: "gw-key",
    label: "GoModel",
  });

  it("probes with its key and reports itself as the target", async () => {
    mockFetch.mockResolvedValueOnce(res({ data: [{ id: "route" }] }));
    expect(await engine.getStatus()).toEqual({
      state: "ready",
      model: "route",
      target: { id: "gateway", label: "GoModel" },
    });
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe("http://g:8090/v1/models");
    expect(init?.headers?.Authorization).toBe("Bearer gw-key");
  });

  it("keeps the target on a status that is not ready", async () => {
    mockFetch.mockResolvedValueOnce(res({}, false, 401));
    expect(await engine.getStatus()).toEqual({
      state: "unauthorized",
      target: { id: "gateway", label: "GoModel" },
    });
  });

  it("sends turns to the route", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("/v1/models")
        ? res({ data: [{ id: "route" }] })
        : res({ choices: [{ message: { content: "hi" } }] }),
    );
    await engine.runAgent([{ role: "user", content: "x" }]).next();
    const chat = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/v1/chat/completions"),
    );
    expect(JSON.parse(chat?.[1]?.body as string).model).toBe("route");
  });
});

describe("reply cap", () => {
  async function capSent(maxTokens?: number): Promise<unknown> {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("/v1/models")
        ? res({ data: [{ id: "route" }] })
        : res({ choices: [{ message: { content: "hi" } }] }),
    );
    const engine = new GatewayEngine({
      bindings,
      baseURL: "http://g:8090",
      model: "route",
      label: "GoModel",
      maxTokens,
    });
    await engine.runAgent([{ role: "user", content: "x" }]).next();
    const chat = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/v1/chat/completions"),
    );
    return JSON.parse(chat?.[1]?.body as string).max_tokens;
  }

  // Reasoning models spend the cap on thinking too; 2048 cut a summary off.
  it("defaults to the largest cap the app allows", async () => {
    expect(await capSent()).toBe(8192);
  });

  it("keeps a cap set in the prompt panel", async () => {
    expect(await capSent(1024)).toBe(1024);
  });
});
