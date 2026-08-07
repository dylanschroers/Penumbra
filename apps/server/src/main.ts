// Must be first: populates process.env from apps/server/.env before any module
// below reads a credential at construction time.
import "./env";
import cors from "@fastify/cors";
import type { AgentEvent, ChatMessage, Engine } from "@penumbra/shared";
import { composeSystem, LAB_POLICY } from "@penumbra/shared";
import Fastify from "fastify";
import { createPromptStore } from "./agent/prompt";
import { registerAgentRoutes } from "./agent/routes";
import { createServerTools } from "./agent/tools";
import { UnslothEngine } from "./agent/UnslothEngine";
import { registerComputeRoutes } from "./compute/routes";
import { createTargetStore } from "./compute/targets";
import { sqlite } from "./db";
import { registerDeviceRoutes } from "./devices/routes";
import { createDeviceStore } from "./devices/store";
import { allowedOrigins } from "./http/cors";
import { trustProxyFromEnv } from "./http/trustProxy";
import { createLabStore } from "./lab/jobs";
import { registerLabRoutes } from "./lab/routes";
import { createServerTaskStore } from "./store/tasks";
import { createTaskSyncStore } from "./sync/store";
import { registerTaskSyncRoutes } from "./sync/tasks";

// bodyLimit covers the Model Lab's upload chunks (a few MB each); the default
// 1 MB would reject them. See registerLabRoutes → POST /lab/upload.
//
// trustProxy is off unless PENUMBRA_TRUST_PROXY names the reverse proxy. Behind
// one, the socket peer is the proxy, so without this every request would read as
// loopback and the auth gate's local-only exemption would open to the network
// (http/trustProxy.ts).
const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024,
  trustProxy: trustProxyFromEnv(process.env.PENUMBRA_TRUST_PROXY),
});

// Raw binary bodies for the upload route; every other route stays JSON. Fastify
// hands the handler a Buffer.
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);

// Only the app's own origins, plus whatever PENUMBRA_ALLOWED_ORIGINS names. See
// ./http/cors: reflecting any origin let a page the user merely *visited* drive
// /agent/* and /lab/* through the loopback exemption in ./http/auth.
await app.register(cors, {
  origin: allowedOrigins(process.env.PENUMBRA_ALLOWED_ORIGINS),
});

app.get("/health", async () => ({ status: "ok" }));

// One sync store over the server's database, shared by the sync routes and the
// agent's task CRUD so both write through the same rev-assigning path.
const sync = createTaskSyncStore(sqlite);
registerTaskSyncRoutes(app, sync);

// Which devices may call the gated routes. Passed to every gate below, so a
// token issued here reaches the agent, the lab, and the compute panel alike —
// one credential per device rather than one per surface.
const devices = createDeviceStore(sqlite);
registerDeviceRoutes(app, { devices });

// Which Studios this server can reach, and which one each role uses. The
// environment supplies the local default; anything set through /compute/targets
// outranks it, so rotating Studio's key is a form in the UI rather than an edit
// to .env and a restart.
const targets = createTargetStore(sqlite);
registerComputeRoutes(app, { targets, devices });

// Model Lab: fine-tuning, export, and benchmarking (docs/MODEL_LAB.md). Same
// gate as the agent routes. Registered before the agent because the agent binds
// what it returns: one lab, driven either from the Lab's own UI or from a
// conversation, so a job started one way is visible and cancellable the other.
const lab = registerLabRoutes(app, {
  store: createLabStore(sqlite),
  targets,
  devices,
});

// Tier 1: the model runs here and executes tools in-process against the store,
// with no client in the turn loop (docs/SYNC.md → Server-side writes).
const tasks = createServerTaskStore(sqlite, sync);
const bindings = createServerTools(tasks, lab);
const prompts = createPromptStore(sqlite);

// Built per call, from whichever target the chat role resolves to right now. An
// engine is a URL, a key, and the bindings — constructing one opens no
// connection — so caching it would buy nothing and would need invalidating
// every time a key rotated or the role was pointed somewhere else.
const currentEngine: Engine = {
  getStatus: () => chatEngine().getStatus(),
  runAgent: (messages: ChatMessage[], signal?: AbortSignal) =>
    chatEngine().runAgent(messages, signal) as AsyncGenerator<AgentEvent>,
};
function chatEngine(): UnslothEngine {
  // The persona is read here rather than captured with the bindings, for the
  // same reason the credentials are: an edit must reach the next turn without a
  // restart, and there is nothing to invalidate if nothing is cached.
  return new UnslothEngine({
    bindings: {
      ...bindings,
      // LAB_POLICY is restated here because this line replaces the system
      // prompt createServerTools composed: dropping it would leave the lab
      // tools advertised with nothing in the prompt saying when to use them.
      system: composeSystem(prompts.current().persona, LAB_POLICY),
    },
    ...targets.resolve("chat"),
  });
}
registerAgentRoutes(app, { engine: currentEngine, targets, prompts, devices });

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
