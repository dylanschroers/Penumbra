import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StudioClient, StudioHttpError } from "../lab/studio";
import { registerComputeRoutes } from "./routes";
import { createTargetStore, type TargetStore } from "./targets";

// The HTTP surface over compute targets. Most of these cases came from
// /lab/provider/* — the settings themselves are unchanged, they just stopped
// being the Lab's private business once chat started reading them.
//
// No Studio is running in these tests, so every probe reports "stopped". That
// is fine: what is under test here is configuration and assignment, not
// reachability, which StudioClient.probe covers on its own.

let app: FastifyInstance;
let targets: TargetStore;

const env = { UNSLOTH_BASE_URL: "http://env:8888", UNSLOTH_API_KEY: "env-key" };

beforeEach(async () => {
  targets = createTargetStore(new Database(":memory:"), env);
  app = Fastify();
  registerComputeRoutes(app, { targets });
  await app.ready();
});
afterEach(() => app?.close());

const get = async () => (await app.inject({ url: "/compute/targets" })).json();
const local = (body: { targets: { id: string }[] }) =>
  body.targets.find((t) => t.id === "local");
const colab = (body: { targets: { id: string }[] }) =>
  body.targets.find((t) => t.id === "colab");

// Changing which model a target serves, from the panel that already says which
// target answers. One GPU holds one model, so a load is always a replacement —
// which is why the route reports what Studio ended up with rather than echoing
// what was asked for.
describe("model loading", () => {
  /** Rebuild the app with a Studio stand-in for the local target. */
  async function withStudio(over: Record<string, unknown>) {
    await app.close();
    app = Fastify();
    registerComputeRoutes(app, {
      targets,
      makeClient: () =>
        ({
          // The probe carries the model with the state: they come from one
          // reading of /v1/models, so a fake that split them could not drift
          // the way the real client cannot.
          probe: async () => ({ state: "ready", served: "resident-model" }),
          loadedModel: async () => "resident-model",
          listLocalModels: async () => [],
          ggufVariants: async () => ({
            variants: [],
            defaultVariant: "Q4_K_M",
          }),
          loadModel: async () => {},
          loadInFlight: async () => false,
          ...over,
        }) as unknown as StudioClient,
      // A lost response is waited out by polling; these tests are not going to
      // sit through three seconds of it.
      loadPollMs: 1,
      loadSettleMs: 500,
    });
    await app.ready();
    return app;
  }

  // The poll is the only call repeated while a panel sits open, so what is
  // loaded rides on it. Without that, a model loaded in Studio's own UI on
  // another machine stays invisible until someone re-opens the panel.
  it("reports the resident model with the target's state", async () => {
    const app = await withStudio({});
    const body = (await app.inject({ url: "/compute/targets" })).json();
    expect(
      body.targets.find((t: { id: string }) => t.id === "local"),
    ).toMatchObject({ state: "ready", servedModel: "resident-model" });
  });

  it("lists a target's models and marks the resident one", async () => {
    const app = await withStudio({
      listLocalModels: async () => [
        {
          id: "a/gguf",
          load_id: "a/gguf",
          display_name: "A",
          size_bytes: 7_000_000_000,
          model_format: "gguf",
          capabilities: { can_chat: true, requires_variant: true },
        },
        {
          id: "resident-model",
          load_id: "resident-model",
          display_name: "Resident",
          size_bytes: 1_000_000_000,
          model_format: "gguf",
          capabilities: { can_chat: true, requires_variant: true },
        },
      ],
    });

    const body = (
      await app.inject({ url: "/compute/targets/local/models" })
    ).json();
    expect(body.models).toHaveLength(2);
    expect(body.models[0]).toMatchObject({
      id: "a/gguf",
      loaded: false,
      requiresVariant: true,
    });
    expect(body.models[1]).toMatchObject({
      id: "resident-model",
      loaded: true,
    });
  });

  // A Colab Studio has nothing on disk until something is downloaded, and the
  // model it is serving may have come from a checkpoint dir or straight from
  // HuggingFace. Offering only inventory rows hid the one model that could
  // answer, on the target where that is the normal case.
  it("offers the resident model even when the inventory does not list it", async () => {
    const app = await withStudio({ listLocalModels: async () => [] });

    const body = (
      await app.inject({ url: "/compute/targets/local/models" })
    ).json();
    expect(body.models).toEqual([
      {
        id: "resident-model",
        label: "resident-model",
        format: "unknown",
        sizeBytes: 0,
        requiresVariant: false,
        loaded: true,
      },
    ]);
    expect(body.inventoryError).toBeNull();
  });

  // An empty list and a list that failed to load send you to different places,
  // so the panel is told which happened rather than left to guess.
  it("reports why an inventory is empty when the call failed", async () => {
    const app = await withStudio({
      listLocalModels: async () => {
        throw new Error("studio /api/hub/local responded 500");
      },
    });

    const body = (
      await app.inject({ url: "/compute/targets/local/models" })
    ).json();
    expect(body.inventoryError).toContain("500");
    // Still usable: what is loaded is still what a benchmark would measure.
    expect(body.models).toMatchObject([{ id: "resident-model", loaded: true }]);
  });

  it("loads a model and reports what the backend ended up serving", async () => {
    const loads: [string, string | undefined][] = [];
    const app = await withStudio({
      loadModel: async (m: string, v?: string) => {
        loads.push([m, v]);
      },
      loadedModel: async () => "a/gguf",
    });

    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local/load",
      payload: { model: "a/gguf" },
    });
    expect(res.statusCode).toBe(200);
    // Not echoed from the request: Studio is the authority on what it serves.
    expect(res.json()).toEqual({ loaded: "a/gguf" });
    // A GGUF repo holds several quants and Studio will not choose, so its own
    // default is resolved on the way through.
    expect(loads).toEqual([["a/gguf", "Q4_K_M"]]);
  });

  it("honours an explicit variant instead of the default", async () => {
    const loads: [string, string | undefined][] = [];
    const app = await withStudio({
      loadModel: async (m: string, v?: string) => {
        loads.push([m, v]);
      },
    });
    await app.inject({
      method: "POST",
      url: "/compute/targets/local/load",
      payload: { model: "a/gguf", variant: "UD-Q8_K_XL" },
    });
    expect(loads).toEqual([["a/gguf", "UD-Q8_K_XL"]]);
  });

  // "It did not load" with no reason sends you to Studio's logs for something
  // this call already knows.
  it("reports why a load failed", async () => {
    const app = await withStudio({
      loadModel: async () => {
        throw new StudioHttpError(
          500,
          "studio /api/inference/load responded 500: OOM",
        );
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local/load",
      payload: { model: "too-big" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "load_failed" });
    expect(res.json().message).toContain("OOM");
  });

  // The Colab case. A load holds the connection while weights page in and the
  // tunnel cuts at ~100s, so the response is lost while the load carries on —
  // reporting that as a failure would send you to reload a model that is
  // already there.
  it("waits out a lost response and reports what ended up loaded", async () => {
    let served = "resident-model";
    const app = await withStudio({
      loadModel: async () => {
        // What a cut tunnel looks like from here: a gateway status, not
        // Studio's own answer.
        throw new StudioHttpError(
          524,
          "studio /api/inference/load responded 524",
        );
      },
      loadedModel: async () => served,
      // Still paging weights in for one poll, then done.
      loadInFlight: async () => {
        served = "new-model";
        return true;
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local/load",
      payload: { model: "new-model" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ loaded: "new-model" });
  });

  // The same drop, with nothing to show for it: Studio settles with the model
  // it already had, so the original error is the honest answer.
  it("gives up on a lost response that never loads anything", async () => {
    const app = await withStudio({
      loadModel: async () => {
        throw new StudioHttpError(504, "gateway timeout");
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local/load",
      payload: { model: "never-arrives" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("gateway timeout");
  });

  it("refuses a target with no address", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab/load",
      payload: { model: "anything" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_configured");
  });

  it("404s an unknown target and 400s a bodyless load", async () => {
    expect(
      (await app.inject({ url: "/compute/targets/lambda/models" })).statusCode,
    ).toBe(404);
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local/load",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("is gated with the rest of the compute surface", async () => {
    const gated = Fastify();
    registerComputeRoutes(gated, { targets, token: "secret" });
    await gated.ready();
    expect(
      (await gated.inject({ url: "/compute/targets/local/models" })).statusCode,
    ).toBe(401);
    expect(
      (
        await gated.inject({
          method: "POST",
          url: "/compute/targets/local/load",
          payload: { model: "x" },
        })
      ).statusCode,
    ).toBe(401);
    await gated.close();
  });
});

describe("auth", () => {
  // Same class of endpoint as /lab and /agent: it decides where a model runs.
  it("refuses a non-loopback caller with no token configured", async () => {
    const res = await app.inject({
      url: "/compute/targets",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(403);
  });

  it("gates the mutating routes", async () => {
    const gated = Fastify();
    registerComputeRoutes(gated, { targets, token: "secret" });
    await gated.ready();
    for (const url of ["/compute/targets/local", "/compute/assign"]) {
      const res = await gated.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
    await gated.close();
  });
});

describe("GET /compute/targets", () => {
  it("lists both targets with where they came from", async () => {
    const body = await get();
    expect(local(body)).toMatchObject({
      baseURL: "http://env:8888",
      source: "env",
      hasKey: true,
      persistence: "persisted",
      configured: true,
    });
    expect(colab(body)).toMatchObject({
      persistence: "session",
      configured: false,
    });
  });

  it("never sends a key back", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/local",
      payload: { apiKey: "rotated" },
    });
    const body = (await app.inject({ url: "/compute/targets" })).body;
    expect(body).not.toContain("rotated");
    expect(body).not.toContain("env-key");
  });

  it("reports assignments and what they resolve to", async () => {
    const body = await get();
    expect(body.assignments).toEqual({ chat: "local", benchmark: "local" });
    expect(body.effective).toEqual({ chat: "local", benchmark: "local" });
  });
});

// Rotating Studio's key used to mean editing .env and restarting the server.
describe("POST /compute/targets/:id", () => {
  it("stores a rotated key and says the settings now govern", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/local",
      payload: { baseURL: "http://studio.lan:8888", apiKey: "rotated" },
    });

    expect(res.statusCode).toBe(200);
    expect(targets.credentials("local").apiKey).toBe("rotated");
    expect(local(await get())).toMatchObject({
      baseURL: "http://studio.lan:8888",
      source: "settings",
    });
  });

  it("rejects an empty patch and a bad URL", async () => {
    for (const payload of [{}, { baseURL: "not-a-url" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/compute/targets/local",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("404s an unknown target rather than inventing one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/lambda",
      payload: { baseURL: "http://x:8888" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("configures Colab, echoing the address but not the bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example", apiKey: "colab-secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("colab-secret");
    expect(colab(await get())).toMatchObject({
      baseURL: "https://tunnel.example",
      configured: true,
      hasKey: true,
    });
  });

  // A key with nothing to attach it to would store silently and read as a save
  // that worked.
  it("refuses a Colab key before an address is known", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { apiKey: "orphan" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("address_required");
  });

  it("allows a Colab key on its own once the address is set", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { apiKey: "later" },
    });
    expect(res.statusCode).toBe(200);
    expect(targets.credentials("colab")).toMatchObject({
      baseURL: "https://tunnel.example",
      apiKey: "later",
    });
  });
});

describe("DELETE /compute/targets/:id", () => {
  it("reverts local to the environment", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/local",
      payload: { baseURL: "http://studio.lan:8888" },
    });
    await app.inject({ method: "DELETE", url: "/compute/targets/local" });
    expect(local(await get())).toMatchObject({
      baseURL: "http://env:8888",
      source: "env",
    });
  });

  it("forgets Colab entirely", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example" },
    });
    await app.inject({ method: "DELETE", url: "/compute/targets/colab" });
    expect(colab(await get())).toMatchObject({ configured: false });
  });
});

describe("POST /compute/assign", () => {
  it("points a role at another target", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/targets/colab",
      payload: { baseURL: "https://tunnel.example" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/compute/assign",
      payload: { role: "chat", target: "colab" },
    });

    expect(res.json()).toMatchObject({
      assignment: "colab",
      effective: "colab",
    });
    expect((await get()).effective.chat).toBe("colab");
  });

  it("leaves the other roles alone", async () => {
    await app.inject({
      method: "POST",
      url: "/compute/assign",
      payload: { role: "benchmark", target: "colab" },
    });
    expect((await get()).assignments).toEqual({
      chat: "local",
      benchmark: "colab",
    });
  });

  // Colab's config dies with the process, so an assignment can outlive the
  // target it names. Reporting both is what lets the UI say so instead of
  // misreporting where answers come from.
  it("reports the fallback when the assigned target is not configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/compute/assign",
      payload: { role: "chat", target: "colab" },
    });
    expect(res.json()).toMatchObject({
      assignment: "colab",
      effective: "local",
    });

    const body = await get();
    expect(body.assignments.chat).toBe("colab");
    expect(body.effective.chat).toBe("local");
  });

  it("rejects an unknown role or target", async () => {
    for (const payload of [
      { role: "training", target: "local" },
      { role: "chat", target: "lambda" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/compute/assign",
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
