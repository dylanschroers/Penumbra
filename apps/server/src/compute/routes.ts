import {
  assignInput,
  type ComputeState,
  loadModelInput,
  targetConfigInput,
  targetId,
} from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import type { DeviceStore } from "../devices/store";
import { isLoopback, requireAuth } from "../http/auth";
import { readInventory, StudioClient, StudioHttpError } from "../lab/studio";
import {
  isLaunchConfigured,
  isStopConfigured,
  type LaunchOutcome,
  launchStudio,
  type StopOutcome,
  stopStudio,
} from "./studioLauncher";
import {
  ROLES,
  type TargetCredentials,
  type TargetId,
  type TargetStore,
} from "./targets";

// Outside /lab/* because chat uses targets too. Gated like the other actuator
// routes.

/** Matches StudioClient.loadModel's own timeout. */
const LOAD_SETTLE_MS = 15 * 60_000;

const LOAD_POLL_MS = 3000;

/**
 * Studio's own 4xx/5xx is a verdict. A gateway status or no response is the
 * connection giving up (e.g. a Cloudflare 524), not the load.
 */
function mayStillBeLoading(err: unknown): boolean {
  if (!(err instanceof StudioHttpError)) return true;
  return (
    err.status === 502 ||
    err.status === 503 ||
    err.status === 504 ||
    err.status >= 520
  );
}

/**
 * `/api/inference/load` holds the connection while weights page in, and the
 * load continues if it drops. Poll Studio and give up only once it is idle
 * with nothing new resident. Returns what ended up serving, or null.
 */
async function settleLoad(
  client: StudioClient,
  baseline: string | null,
  pollMs: number,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  // A load that hasn't registered yet looks like none, so require three quiet
  // polls.
  let quiet = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const served = await client.loadedModel().catch(() => null);
    if (served && served !== baseline) return served;
    if (await client.loadInFlight()) {
      quiet = 0;
      continue;
    }
    if (++quiet >= 3) return null;
  }
  return null;
}

export interface ComputeRouteOptions {
  targets: TargetStore;
  token?: string;
  makeClient?: (id: TargetId, creds: TargetCredentials) => StudioClient;
  loadPollMs?: number;
  loadSettleMs?: number;
  devices?: DeviceStore;
  launch?: () => LaunchOutcome;
  launchConfigured?: boolean;
  stop?: () => StopOutcome;
  stopConfigured?: boolean;
}

export function registerComputeRoutes(
  app: FastifyInstance,
  {
    targets,
    token = process.env.PENUMBRA_AGENT_TOKEN,
    devices,
    makeClient = (_id, creds) => new StudioClient(creds),
    loadPollMs = LOAD_POLL_MS,
    loadSettleMs = LOAD_SETTLE_MS,
    launch = () => launchStudio(),
    launchConfigured = isLaunchConfigured(),
    stop = () => stopStudio(),
    stopConfigured = isStopConfigured(),
  }: ComputeRouteOptions,
): void {
  const preHandler = requireAuth({ token, devices });

  const clientFor = (id: TargetId): StudioClient | null =>
    targets.list().find((t) => t.id === id)?.configured
      ? makeClient(id, targets.credentials(id))
      : null;

  app.get(
    "/compute/targets",
    { preHandler },
    async (req): Promise<ComputeState> => {
      const listed = targets.list();
      // Per request: only loopback callers can launch.
      const onMachine = isLoopback(req.ip);
      const launchable = launchConfigured && onMachine;
      const stoppable = stopConfigured && onMachine;
      const idle = { state: "stopped" as const, served: null };
      const probes = await Promise.all(
        listed.map((t) =>
          t.configured
            ? (clientFor(t.id)?.probe() ?? Promise.resolve(idle))
            : Promise.resolve(idle),
        ),
      );

      return {
        targets: listed.map((t, i) => ({
          ...t,
          state: probes[i]?.state ?? "stopped",
          // Same `/v1/models` read that decides readiness, so it's free.
          servedModel: probes[i]?.served ?? null,
          canLaunch: t.id === "local" && launchable,
          canStop: t.id === "local" && stoppable,
        })),
        assignments: Object.fromEntries(
          ROLES.map((r) => [r, targets.assignment(r)]),
        ),
        effective: Object.fromEntries(
          ROLES.map((r) => [r, targets.effective(r)]),
        ),
      } as ComputeState;
    },
  );

  /**
   * Per target, not per role. An unconfigured or unreachable target answers an
   * empty list; a failed inventory on a live target sets `inventoryError`.
   */
  app.get<{ Params: { id: string } }>(
    "/compute/targets/:id/models",
    { preHandler },
    async (req, reply) => {
      const id = targetId.safeParse(req.params.id);
      if (!id.success) return reply.code(404).send({ error: "unknown_target" });
      const client = clientFor(id.data);
      if (!client) return { models: [], inventoryError: null };

      return readInventory(client);
    },
  );

  /**
   * Evicts whatever was loaded (one GPU, one model). Held open rather than
   * returning a job id: loads take seconds to minutes.
   */
  app.post<{ Params: { id: string } }>(
    "/compute/targets/:id/load",
    { preHandler },
    async (req, reply) => {
      const id = targetId.safeParse(req.params.id);
      if (!id.success) return reply.code(404).send({ error: "unknown_target" });
      const parsed = loadModelInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      const client = clientFor(id.data);
      if (!client) {
        return reply.code(409).send({
          error: "not_configured",
          message: `${id.data} has no address set`,
        });
      }

      // Baseline so a lost response can be told apart from a load that never
      // happened.
      const before = await client.loadedModel().catch(() => null);

      try {
        // Studio won't pick a GGUF quant, so resolve the repo default. Non-GGUF repos
        // report none.
        let variant = parsed.data.variant;
        if (!variant) {
          variant = (await client
            .ggufVariants(parsed.data.model)
            .then((v) => v.defaultVariant)
            .catch(() => undefined)) as string | undefined;
        }
        await client.loadModel(parsed.data.model, variant);
      } catch (err) {
        const settled = mayStillBeLoading(err)
          ? await settleLoad(client, before, loadPollMs, loadSettleMs)
          : null;
        if (!settled) {
          return reply.code(502).send({
            error: "load_failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return { loaded: settled };
      }

      // Read back from Studio, not echoed from the request.
      const served = await client.loadedModel().catch(() => null);
      return { loaded: served };
    },
  );

  /**
   * Loopback-only on top of the gate: a device token doesn't grant spawning
   * processes. Returns 202; Studio takes ~45s to bind and the targets poll shows
   * it ready.
   */
  app.post<{ Params: { id: string } }>(
    "/compute/targets/:id/launch",
    { preHandler },
    async (req, reply) => {
      if (!isLoopback(req.ip)) {
        return reply.code(403).send({
          error: "local_only",
          message: "Studio can only be launched from the server's own machine.",
        });
      }
      if (req.params.id !== "local") {
        return reply.code(409).send({
          error: "not_launchable",
          message: "Only the local Studio can be launched from here.",
        });
      }
      if (!launchConfigured) {
        return reply.code(409).send({
          error: "not_configured",
          message: "No launch command is set (UNSLOTH_LAUNCH_CMD).",
        });
      }

      // "ready", "unauthorized", and "not_studio" all mean the port is taken.
      const client = clientFor("local");
      const probe = client
        ? await client.probe()
        : { state: "stopped" as const };
      if (probe.state !== "stopped") {
        return reply.code(409).send({
          error: "already_running",
          message: `The local target is already ${probe.state}.`,
        });
      }

      const outcome = launch();
      if (!outcome.ok) {
        const code = outcome.reason === "already_launching" ? 409 : 500;
        return reply
          .code(code)
          .send({ error: outcome.reason, message: outcome.message });
      }
      return reply.code(202).send({ launching: true });
    },
  );

  /** Same gate as launch. Fire-and-forget; stopping a stopped Studio is a no-op. */
  app.post<{ Params: { id: string } }>(
    "/compute/targets/:id/stop",
    { preHandler },
    async (req, reply) => {
      if (!isLoopback(req.ip)) {
        return reply.code(403).send({
          error: "local_only",
          message: "Studio can only be stopped from the server's own machine.",
        });
      }
      if (req.params.id !== "local") {
        return reply.code(409).send({
          error: "not_stoppable",
          message: "Only the local Studio can be stopped from here.",
        });
      }
      if (!stopConfigured) {
        return reply.code(409).send({
          error: "not_configured",
          message: "No stop command is set (UNSLOTH_STOP_CMD).",
        });
      }
      const outcome = stop();
      if (!outcome.ok) {
        return reply
          .code(500)
          .send({ error: outcome.reason, message: outcome.message });
      }
      return reply.code(202).send({ stopping: true });
    },
  );

  // Write-only: GET reports only `hasKey`.
  app.post("/compute/targets/:id", { preHandler }, async (req, reply) => {
    const id = targetId.safeParse(
      (req.params as { id?: string } | undefined)?.id,
    );
    if (!id.success) return reply.code(404).send({ error: "unknown_target" });

    const parsed = targetConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    // An empty patch would look like a save that worked. Colab needs an address
    // before a key.
    if (parsed.data.baseURL === undefined && parsed.data.apiKey === undefined) {
      return reply.code(400).send({ error: "bad_request" });
    }
    if (
      id.data === "colab" &&
      parsed.data.baseURL === undefined &&
      !targets.list().find((t) => t.id === "colab")?.configured
    ) {
      return reply.code(400).send({ error: "address_required" });
    }

    targets.set(id.data, parsed.data);
    return { ok: true };
  });

  app.delete("/compute/targets/:id", { preHandler }, async (req, reply) => {
    const id = targetId.safeParse(
      (req.params as { id?: string } | undefined)?.id,
    );
    if (!id.success) return reply.code(404).send({ error: "unknown_target" });
    targets.clear(id.data);
    return { ok: true };
  });

  app.post("/compute/assign", { preHandler }, async (req, reply) => {
    const parsed = assignInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    targets.assign(parsed.data.role, parsed.data.target);
    // Can differ from what was asked: an unconfigured Colab resolves to local.
    return {
      ok: true,
      assignment: parsed.data.target,
      effective: targets.effective(parsed.data.role),
    };
  });
}
