import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StudioClient, TrainingBusyError } from "./studio";

// Driven against a real HTTP server rather than a stubbed fetch, so request
// shape, headers, and SSE framing are all exercised for real.
//
// What this cannot prove: that Unsloth Studio behaves like this fake. The fake
// encodes the same reading of Studio's API that the client does
// (docs/model_lab_plan.md → verified facts), so only a live Studio can confirm
// it. It catches our bugs, not our misunderstandings.

interface Recorded {
  method: string;
  url: string;
  auth?: string;
  body: Record<string, unknown>;
}

function startFakeStudio(
  handler: (req: Recorded) => { status?: number; body?: unknown; sse?: string },
) {
  const recorded: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const entry: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      };
      recorded.push(entry);
      const reply = handler(entry);
      if (reply.sse !== undefined) {
        res.writeHead(reply.status ?? 200, {
          "Content-Type": "text/event-stream",
        });
        res.end(reply.sse);
        return;
      }
      res.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  return {
    recorded,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let studio: ReturnType<typeof startFakeStudio>;
afterEach(() => studio?.close());

async function client(
  handler: Parameters<typeof startFakeStudio>[0],
  apiKey?: string,
) {
  studio = startFakeStudio(handler);
  const baseURL = await studio.listen();
  return new StudioClient({ baseURL, apiKey, env: {} });
}

const startBody = {
  model_name: "qwen",
  training_type: "LoRA/QLoRA",
  learning_rate: 2e-4,
  max_steps: 60,
  lora_r: 16,
  load_in_4bit: true,
};

describe("configuration", () => {
  it("reads base URL and key from the environment", () => {
    const c = new StudioClient({
      env: { UNSLOTH_BASE_URL: "gpu-host:8888", UNSLOTH_API_KEY: "sk-x" },
    });
    // Also normalizes a scheme-less host, which would otherwise silently
    // produce relative URLs.
    expect(c.baseURL).toBe("http://gpu-host:8888");
  });

  it("sends the bearer token", async () => {
    const c = await client(() => ({ body: { runs: [] } }), "sk-secret");
    await c.listRuns();
    expect(studio.recorded[0]?.auth).toBe("Bearer sk-secret");
  });

  // Studio rejects an empty bearer as malformed, so it must be absent.
  it("omits the header entirely when no key is set", async () => {
    const c = await client(() => ({ body: { runs: [] } }));
    await c.listRuns();
    expect(studio.recorded[0]?.auth).toBeUndefined();
  });
});

describe("startTraining", () => {
  it("posts the training request", async () => {
    const c = await client(() => ({ body: { status: "ok" } }));
    await c.startTraining(startBody);

    expect(studio.recorded[0]).toMatchObject({
      method: "POST",
      url: "/api/train/start",
    });
    expect(studio.recorded[0]?.body).toMatchObject({
      training_type: "LoRA/QLoRA",
      load_in_4bit: true,
    });
  });

  // Studio answers a second concurrent run with 200 + status:"error", not a
  // non-2xx, so this would otherwise look like success.
  it("raises TrainingBusyError when Studio refuses", async () => {
    const c = await client(() => ({
      body: { status: "error", message: "training already running" },
    }));
    await expect(c.startTraining(startBody)).rejects.toBeInstanceOf(
      TrainingBusyError,
    );
  });

  it("throws on a transport failure", async () => {
    const c = await client(() => ({ status: 500, body: {} }));
    await expect(c.startTraining(startBody)).rejects.toThrow("responded 500");
  });
});

describe("trainingProgress", () => {
  it("decodes progress frames in order", async () => {
    const c = await client(() => ({
      sse:
        `event: progress\ndata: {"step":1,"total_steps":60}\n\n` +
        `event: progress\ndata: {"step":2,"total_steps":60,"loss":0.9}\n\n` +
        `event: complete\ndata: {}\n\n`,
    }));

    const frames = [];
    for await (const f of c.trainingProgress()) frames.push(f);

    expect(frames.map((f) => f.event)).toEqual([
      "progress",
      "progress",
      "complete",
    ]);
    expect(frames[1]?.data).toMatchObject({ step: 2, loss: 0.9 });
  });

  // A garbled frame must not abort a training run that may have hours invested.
  it("skips a malformed frame and keeps going", async () => {
    const c = await client(() => ({
      sse:
        `event: progress\ndata: {oops\n\n` +
        `event: complete\ndata: {"ok":true}\n\n`,
    }));

    const frames = [];
    for await (const f of c.trainingProgress()) frames.push(f);
    expect(frames.map((f) => f.event)).toEqual(["complete"]);
  });
});

describe("listRuns", () => {
  it("accepts both the wrapped and bare array shapes", async () => {
    const wrapped = await client(() => ({
      body: { runs: [{ output_dir: "/a" }] },
    }));
    expect(await wrapped.listRuns()).toEqual([{ output_dir: "/a" }]);
    await studio.close();

    const bare = await client(() => ({ body: [{ output_dir: "/b" }] }));
    expect(await bare.listRuns()).toEqual([{ output_dir: "/b" }]);
  });
});

describe("export", () => {
  it("loads the checkpoint then requests the GGUF", async () => {
    const c = await client(() => ({ body: { status: "ok" } }));
    await c.loadCheckpoint("/runs/1");
    await c.exportGguf("/runs/1/gguf", "Q4_K_M");

    expect(studio.recorded.map((r) => r.url)).toEqual([
      "/api/export/load-checkpoint",
      "/api/export/gguf",
    ]);
    expect(studio.recorded[0]?.body).toEqual({ checkpoint_path: "/runs/1" });
    expect(studio.recorded[1]?.body).toEqual({
      save_directory: "/runs/1/gguf",
      quantization_method: "Q4_K_M",
    });
  });
});

describe("reachable", () => {
  it("is true when Studio answers", async () => {
    const c = await client(() => ({ body: { data: [] } }));
    expect(await c.reachable()).toBe(true);
  });

  it("is false when nothing is listening", async () => {
    const c = new StudioClient({ baseURL: "http://127.0.0.1:1", env: {} });
    expect(await c.reachable()).toBe(false);
  });
});
