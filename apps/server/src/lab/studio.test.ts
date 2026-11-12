import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StudioClient, TrainingBusyError } from "./studio";

// Real HTTP server, not stubbed fetch. Encodes our reading of Studio's API, so
// only a live Studio confirms it.

interface Recorded {
  method: string;
  url: string;
  auth?: string;
  body: Record<string, unknown>;
}

function startFakeStudio(
  handler: (req: Recorded) => {
    status?: number;
    body?: unknown;
    sse?: string;
    html?: string;
  },
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
      if (reply.html !== undefined) {
        res.writeHead(reply.status ?? 200, { "Content-Type": "text/html" });
        res.end(reply.html);
        return;
      }
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
  format_type: "auto",
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
    expect(c.baseURL).toBe("http://gpu-host:8888");
  });

  it("sends the bearer token", async () => {
    const c = await client(() => ({ body: { runs: [] } }), "sk-secret");
    await c.listRuns();
    expect(studio.recorded[0]?.auth).toBe("Bearer sk-secret");
  });

  // Studio rejects an empty bearer as malformed.
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

  // Studio answers a concurrent run with 200 + status:"error".
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

  it("includes the response body so a 422 explains itself", async () => {
    const c = await client(() => ({
      status: 422,
      body: {
        detail: [{ loc: ["body", "format_type"], msg: "Field required" }],
      },
    }));
    await expect(c.startTraining(startBody)).rejects.toThrow(/format_type/);
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

    // The doubled segment is real; /api/export/gguf answers 405.
    expect(studio.recorded.map((r) => r.url)).toEqual([
      "/api/export/load-checkpoint",
      "/api/export/export/gguf",
    ]);
    expect(studio.recorded[0]?.body).toEqual({ checkpoint_path: "/runs/1" });
    expect(studio.recorded[1]?.body).toEqual({
      save_directory: "/runs/1/gguf",
      quantization_method: "Q4_K_M",
    });
  });
});

describe("reachable / probe", () => {
  it("is ready when Studio answers, with nothing serving yet", async () => {
    const c = await client(() => ({ body: { data: [] } }));
    expect(await c.reachable()).toBe(true);
    expect(await c.probe()).toEqual({ state: "ready", served: null });
  });

  // Uses pickLoadedModel, so a merely downloaded model isn't reported.
  it("reports the resident model from the same listing", async () => {
    const c = await client(() => ({
      body: {
        data: [
          { id: "on-disk", loaded: false },
          { id: "unsloth/gemma-4-12b-it", loaded: true },
        ],
      },
    }));
    expect(await c.probe()).toEqual({
      state: "ready",
      served: "unsloth/gemma-4-12b-it",
    });
  });

  it("reports the resident model when no entry carries a flag", async () => {
    const c = await client(() => ({
      body: { data: [{ id: "unsloth/gemma-4-12b-it" }] },
    }));
    expect((await c.probe()).served).toBe("unsloth/gemma-4-12b-it");
  });

  it("reports unauthorized on a 401 rather than stopped", async () => {
    const c = await client(() => ({
      status: 401,
      body: { error: { message: "Not authenticated" } },
    }));
    expect(await c.probe()).toEqual({ state: "unauthorized", served: null });
    expect(await c.reachable()).toBe(false);
  });

  it("is stopped when nothing is listening", async () => {
    const c = new StudioClient({ baseURL: "http://127.0.0.1:1", env: {} });
    expect((await c.probe()).state).toBe("stopped");
    expect(await c.reachable()).toBe(false);
  });

  // A proxy in front of Studio (e.g. Colab's sign-in redirect) answers 200 with
  // HTML.
  it("is not_studio when a 200 comes back that is not a model listing", async () => {
    const c = await client(() => ({
      html: "<!doctype html><title>Sign in - Google Accounts</title>",
    }));
    expect(await c.probe()).toEqual({ state: "not_studio", served: null });
    expect(await c.reachable()).toBe(false);
  });

  it("is not_studio when the body is JSON without a listing", async () => {
    const c = await client(() => ({ body: { status: "ok" } }));
    expect((await c.probe()).state).toBe("not_studio");
  });
});
