import {
  assignInput,
  type ComputeState,
  loadModelInput,
  targetConfigInput,
  targetId,
} from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../http/auth";
import { StudioClient, toAvailableModels } from "../lab/studio";
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

export interface ComputeRouteOptions {
  targets: TargetStore;
  token?: string;
  /** Builds the Studio client for a target. Injected so tests can drive these
   *  routes without a live Studio, the same seam the lab routes use. */
  makeClient?: (id: TargetId, creds: TargetCredentials) => StudioClient;
}

export function registerComputeRoutes(
  app: FastifyInstance,
  {
    targets,
    token = process.env.PENUMBRA_AGENT_TOKEN,
    makeClient = (_id, creds) => new StudioClient(creds),
  }: ComputeRouteOptions,
): void {
  const preHandler = requireAuth(token);

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
    async (): Promise<ComputeState> => {
      // Probed in parallel: an unreachable target should cost one timeout, not
      // one per target in series.
      const listed = targets.list();
      const states = await Promise.all(
        listed.map((t) =>
          // An unconfigured target has no address to probe, and "stopped" is the
          // honest answer for one that does not exist yet.
          t.configured
            ? (clientFor(t.id)?.probe() ?? Promise.resolve("stopped" as const))
            : Promise.resolve("stopped" as const),
        ),
      );

      return {
        targets: listed.map((t, i) => ({
          ...t,
          state: states[i] ?? "stopped",
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
   * state as the reason.
   */
  app.get<{ Params: { id: string } }>(
    "/compute/targets/:id/models",
    { preHandler },
    async (req, reply) => {
      const id = targetId.safeParse(req.params.id);
      if (!id.success) return reply.code(404).send({ error: "unknown_target" });
      const client = clientFor(id.data);
      if (!client) return { models: [] };

      const [models, served] = await Promise.all([
        client.listLocalModels().catch(() => []),
        client.loadedModel().catch(() => null),
      ]);
      return { models: toAvailableModels(models, served) };
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
        // Surfaced rather than swallowed: "it did not load" with no reason
        // sends you to Studio's logs to find out what this call already knows.
        return reply.code(502).send({
          error: "load_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Reported back from the backend, not echoed from the request: Studio is
      // the authority on what it ended up serving.
      const served = await client.loadedModel().catch(() => null);
      return { loaded: served };
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
