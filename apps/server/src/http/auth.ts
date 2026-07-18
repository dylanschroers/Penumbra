import type { FastifyReply, FastifyRequest } from "fastify";

// The gate for every endpoint that *acts* rather than moves data.
//
// /sync/tasks runs without auth on purpose (single user, LAN — docs/SYNC.md).
// The agent and lab routes are a different class: they run models with write
// and delete tools, spawn training jobs, write files, and cost GPU. They carry
// their own gate so that posture never has to be relaxed for them.

/** Loopback callers are inside the trust boundary the v0 model assumes. */
function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * With GHOST_AGENT_TOKEN set, callers present it as a bearer token — that is
 * what makes these routes reachable from another device on the LAN. Without it,
 * only loopback is served, so an unconfigured server can never expose an
 * actuator to the network by accident. There is deliberately no open mode.
 */
export function requireAuth(token: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!token) {
      if (isLoopback(req.ip)) return;
      await reply.code(403).send({
        error: "local_only",
        message:
          "This route serves loopback only until GHOST_AGENT_TOKEN is set.",
      });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
