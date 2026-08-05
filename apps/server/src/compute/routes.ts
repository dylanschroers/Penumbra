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
  type LaunchOutcome,
  launchStudio,
} from "./studioLauncher";
import {
  ROLES,
  type TargetCredentials,
  type TargetId,
  type TargetStore,
} from "./targets";

// Which Studios the server can reach, and which one each role uses.
//
// These live outside /lab/* because chat depends on them too — the Studio a
// conversation runs against is the same setting the Lab was quietly owning.
// Same gate as the agent and lab routes: this configures where a model runs and
// costs GPU, so it is an actuator, not data.

/** How long a load may keep working after its response was lost. Matches the
 *  timeout StudioClient.loadModel gives the request itself: past that, whatever
 *  is happening over there is no longer this request's business. */
const LOAD_SETTLE_MS = 15 * 60_000;

/** Between settle polls. Long enough to be free, short enough that a load that
 *  finished right after the drop is not left sitting. */
const LOAD_POLL_MS = 3000;

/**
 * Whether a failed load may still be running on the other side.
 *
 * Studio answering for itself — a 4xx on a bad id, a 500 on an OOM — is a
 * verdict, and waiting on it would stall for nothing. A gateway status or no
 * response at all is the *connection* giving up, which says nothing about the
 * load: that is the Cloudflare 524 the export path documents, hit here by any
 * load slow enough to matter.
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
 * Wait out a load whose response never came back.
 *
 * Weights page in for minutes while `/api/inference/load` holds the connection
 * open, while the load carries on inside Studio regardless of what happens to
 * the connection. So ask Studio what it is doing, and give up only once it is
 * doing nothing *and* nothing new is resident.
 *
 * Returns the model that ended up serving, or null if none did.
 */
async function settleLoad(
  client: StudioClient,
  baseline: string | null,
  pollMs: number,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  // A load that has not registered yet looks exactly like one that never
  // started, so a single quiet poll is not an answer. Three is.
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
  /** Builds the Studio client for a target. Injected so tests can drive these
   *  routes without a live Studio, the same seam the lab routes use. */
  makeClient?: (id: TargetId, creds: TargetCredentials) => StudioClient;
  /** How a load whose response was lost is waited out. Overridden only by tests,
   *  which have no patience for real polling. */
  loadPollMs?: number;
  loadSettleMs?: number;
  /** Issued device tokens, accepted alongside the shared secret. Optional so a
   *  test can stand these routes up without a device store. */
  devices?: DeviceStore;
  /** Spawns the local Studio. Injected so a test can assert the launch without
   *  starting a real GPU server. */
  launch?: () => LaunchOutcome;
  /** Whether a launch command is configured at all. Injected so a test can
   *  drive the button-visibility and refusal paths without touching the env. */
  launchConfigured?: boolean;
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
  }: ComputeRouteOptions,
): void {
  const preHandler = requireAuth({ token, devices });

  /** The Studio for a target, or null when it has no address yet. Built per
   *  call for the same reason the lab's is: a client is a URL and a header map,
   *  so there is nothing to keep alive and nothing that can go stale. */
  const clientFor = (id: TargetId): StudioClient | null =>
    targets.list().find((t) => t.id === id)?.configured
      ? makeClient(id, targets.credentials(id))
      : null;

  app.get(
    "/compute/targets",
    { preHandler },
    async (req): Promise<ComputeState> => {
      // Probed in parallel: an unreachable target should cost one timeout, not
      // one per target in series.
      const listed = targets.list();
      // Only a loopback caller can launch, so the flag is decided per request:
      // the same listing off-machine reports canLaunch false and hides the
      // button rather than offering one the launch route would refuse.
      const launchable = launchConfigured && isLoopback(req.ip);
      // An unconfigured target has no address to probe, and "stopped" with
      // nothing serving is the honest answer for one that does not exist yet.
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
          // Free, because readiness is decided by reading the very listing that
          // names it. This is what makes a model loaded on Colab show up here
          // on the next poll instead of waiting for someone to re-open a panel.
          servedModel: probes[i]?.served ?? null,
          // Local only: there is no spawning a process on a remote target.
          canLaunch: t.id === "local" && launchable,
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
   * What this target can serve, and which of it is resident.
   *
   * Per target rather than per role: the panel edits both cards, and asking
   * "what does the benchmark role have" would list the wrong machine's models
   * on the other one. /lab/models answers the role question for the benchmark
   * form; both map through the same helper so they cannot disagree.
   *
   * A target that is unconfigured or unreachable answers with an empty list
   * rather than an error, so the card stays usable and keeps reporting its own
   * state as the reason. An inventory that fails on a target that *is* answering
   * reports why in `inventoryError`, which is a different problem and a
   * different fix.
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
   * Make a model resident on this target.
   *
   * One GPU holds one model, so this evicts what was loaded — including the
   * model a conversation is mid-thread with. That is the point of the control,
   * and the transcript marker is what stops the switch being silent.
   *
   * Held open until Studio answers rather than returning a job id: a load is
   * seconds to minutes, the client has nothing else to do meanwhile, and an
   * error here is worth reporting directly instead of being buried in a job row.
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

      // What was serving before, so a load whose response is lost can be told
      // apart from one that never happened — the same baseline trick export
      // takes against Studio's op counter.
      const before = await client.loadedModel().catch(() => null);

      try {
        // Studio will not guess between a GGUF repo's quantizations, so when
        // the caller did not name one, its own default is resolved first. A
        // repo that turns out not to be GGUF simply reports none, and the load
        // proceeds without.
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
          // Surfaced rather than swallowed: "it did not load" with no reason
          // sends you to Studio's logs for what this call already knows.
          return reply.code(502).send({
            error: "load_failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return { loaded: settled };
      }

      // Reported back from the backend, not echoed from the request: Studio is
      // the authority on what it ended up serving.
      const served = await client.loadedModel().catch(() => null);
      return { loaded: served };
    },
  );

  /**
   * Start the local Studio.
   *
   * Loopback-only, on top of the gate. Spawning a process on the host is more
   * than a device token grants, so even a valid one from another machine cannot
   * reach this — only a caller on the server's own box, which is also the only
   * box where starting a local process means anything.
   *
   * 202 and done: Studio takes ~45s to bind, and the /compute/targets poll is
   * what turns the card ready. Nothing here waits on it.
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

      // Don't spawn a second process over one that is already there. "ready",
      // "unauthorized" (up, wrong key), and "not_studio" (something else on the
      // port) all mean the port is taken and a fresh Studio would only fail to
      // bind; only a target that answers nothing is worth starting.
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
        // A double-click during startup is a 409 (it is coming); a failed spawn
        // is a 500 (it is not).
        const code = outcome.reason === "already_launching" ? 409 : 500;
        return reply
          .code(code)
          .send({ error: outcome.reason, message: outcome.message });
      }
      return reply.code(202).send({ launching: true });
    },
  );

  // Point a target somewhere, or hand it a rotated key. The value is written,
  // never read back — a GET reports only `hasKey`.
  app.post("/compute/targets/:id", { preHandler }, async (req, reply) => {
    const id = targetId.safeParse(
      (req.params as { id?: string } | undefined)?.id,
    );
    if (!id.success) return reply.code(404).send({ error: "unknown_target" });

    const parsed = targetConfigInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    // An empty patch would silently do nothing, which reads as a save that
    // worked. Colab additionally needs an address before a key means anything.
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

  // Forget a target: back to the environment for local, unconfigured for Colab.
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
    // The effective target is returned because it can differ from what was just
    // asked for: assigning an unconfigured Colab resolves back to local, and a
    // caller that assumed otherwise would misreport where answers come from.
    return {
      ok: true,
      assignment: parsed.data.target,
      effective: targets.effective(parsed.data.role),
    };
  });
}
