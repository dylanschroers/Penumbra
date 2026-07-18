import type { AgentEvent } from "@penumbra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteEngine } from "./RemoteEngine";

// Sync is a module-level singleton driving the real store, so it is mocked
// here; the assertions below are precisely about *when* the engine calls it.
const flushSync = vi.fn().mockResolvedValue(undefined);
const requestSync = vi.fn();
vi.mock("../sync/SyncClient", () => ({
  flushSync: () => flushSync(),
  requestSync: () => requestSync(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** A Response whose body streams the given SSE frames. */
function sseResponse(frames: Array<[string, unknown]>, ok = true): Response {
  const text = frames
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
  return {
    ok,
    status: ok ? 200 : 500,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  } as unknown as Response;
}

const toolRun: AgentEvent = {
  kind: "tool",
  name: "create_task",
  args: { title: "x" },
  result: "Created.",
};
const answer: AgentEvent = { kind: "answer", text: "done" };

async function collect(engine: RemoteEngine): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of engine.runAgent([{ role: "user", content: "x" }])) {
    out.push(ev);
  }
  return out;
}

beforeEach(() => {
  mockFetch.mockReset();
  flushSync.mockClear();
  requestSync.mockClear();
});

describe("getStatus", () => {
  it("relays the server's status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ state: "ready", model: "gpt-oss" }),
    } as Response);
    expect(await new RemoteEngine().getStatus()).toEqual({
      state: "ready",
      model: "gpt-oss",
    });
  });

  it("reports stopped when no server answers", async () => {
    mockFetch.mockRejectedValueOnce(new Error("refused"));
    expect(await new RemoteEngine().getStatus()).toEqual({ state: "stopped" });
  });

  it("sends the configured token", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ state: "ready" }),
    } as Response);
    await new RemoteEngine({ token: "secret" }).getStatus();
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer secret",
    });
  });
});

describe("runAgent", () => {
  it("yields each streamed event and stops at done", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        ["agent", toolRun],
        ["agent", answer],
        ["done", {}],
      ]),
    );
    expect(await collect(new RemoteEngine())).toEqual([toolRun, answer]);
  });

  // The turn reads the server's store, so unpushed local edits would be
  // invisible to the model without this.
  it("flushes pending local edits before the turn starts", async () => {
    mockFetch.mockResolvedValue(sseResponse([["done", {}]]));
    await collect(new RemoteEngine());
    expect(flushSync).toHaveBeenCalledTimes(1);
  });

  it("still runs the turn when the pre-turn flush fails", async () => {
    flushSync.mockRejectedValueOnce(new Error("offline"));
    mockFetch.mockResolvedValue(
      sseResponse([
        ["agent", answer],
        ["done", {}],
      ]),
    );
    expect(await collect(new RemoteEngine())).toEqual([answer]);
  });

  // Tools wrote on the server; without a pull the client would not show the
  // change until the next interval tick.
  it("pulls after a tool run, but not after a plain answer", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        ["agent", toolRun],
        ["agent", answer],
        ["done", {}],
      ]),
    );
    await collect(new RemoteEngine());
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it("surfaces a server error event as a thrown error", async () => {
    mockFetch.mockResolvedValue(
      sseResponse([["error", { message: "studio responded 500" }]]),
    );
    await expect(collect(new RemoteEngine())).rejects.toThrow(
      "studio responded 500",
    );
  });

  it("throws on a non-OK response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 } as Response);
    await expect(collect(new RemoteEngine())).rejects.toThrow(
      "agent server responded 401",
    );
  });

  // Frames are not guaranteed to align with chunk boundaries.
  it("reassembles a frame split across chunks", async () => {
    const text = `event: agent\ndata: ${JSON.stringify(answer)}\n\nevent: done\ndata: {}\n\n`;
    const cut = 20;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(text.slice(0, cut)));
          controller.enqueue(enc.encode(text.slice(cut)));
          controller.close();
        },
      }),
    } as unknown as Response);

    expect(await collect(new RemoteEngine())).toEqual([answer]);
  });
});
