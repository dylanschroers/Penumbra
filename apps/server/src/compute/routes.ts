import {
  assignInput,
  type ComputeState,
  targetConfigInput,
  targetId,
} from "@penumbra/shared";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../http/auth";
import { StudioClient } from "../lab/studio";
import { ROLES, type TargetStore } from "./targets";

// Which Studios the server can reach, and which one each role uses.
//
// These live outside /lab/* because chat depends on them too — the Studio a
// conversation runs against is the same setting the Lab was quietly owning.
// Same gate as the agent and lab routes: this configures where a model runs and
// costs GPU, so it is an actuator, not data.

export interface ComputeRouteOptions {
  targets: TargetStore;
  token?: string;
}

export function registerComputeRoutes(
  app: FastifyInstance,
  { targets, token = process.env.PENUMBRA_AGENT_TOKEN }: ComputeRouteOptions,
): void {
  const preHandler = requireAuth(token);

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
            ? new StudioClient(targets.credentials(t.id)).probe()
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
