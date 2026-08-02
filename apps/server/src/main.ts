// Must be first: populates process.env from apps/server/.env before any module
// below reads a credential at construction time.
import "./env";
import cors from "@fastify/cors";
import type { AgentEvent, ChatMessage, Engine } from "@penumbra/shared";
import { composeSystem } from "@penumbra/shared";
import Fastify from "fastify";
import { createPromptStore } from "./agent/prompt";
import { registerAgentRoutes } from "./agent/routes";
import { createServerTools } from "./agent/tools";
import { UnslothEngine } from "./agent/UnslothEngine";
import { registerComputeRoutes } from "./compute/routes";
import { createTargetStore } from "./compute/targets";
import { sqlite } from "./db";
import { createLabStore } from "./lab/jobs";
import { registerLabRoutes } from "./lab/routes";
import { createServerTaskStore } from "./store/tasks";
import { createTaskSyncStore } from "./sync/store";
import { registerTaskSyncRoutes } from "./sync/tasks";

// bodyLimit covers the Model Lab's upload chunks (a few MB each); the default
// 1 MB would reject them. See registerLabRoutes → POST /lab/upload.
const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024 });

// Raw binary bodies for the upload route; every other route stays JSON. Fastify
// hands the handler a Buffer.
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);

// v0 has no auth (single user, LAN/localhost — see docs/SYNC.md), so reflect any
// origin. Lock this down before the server ever faces the open internet. The
// agent routes do not rely on this and carry their own gate (./agent/routes).
await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

// One sync store over the server's database, shared by the sync routes and the
// agent's task CRUD so both write through the same rev-assigning path.
const sync = createTaskSyncStore(sqlite);
registerTaskSyncRoutes(app, sync);

// Which Studios this server can reach, and which one each role uses. The
// environment supplies the local default; anything set through /compute/targets
// outranks it, so rotating Studio's key is a form in the UI rather than an edit
// to .env and a restart.
const targets = createTargetStore(sqlite);
registerComputeRoutes(app, { targets });

// Tier 1: the model runs here and executes tools in-process against the store,
// with no client in the turn loop (docs/SYNC.md → Server-side writes).
const tasks = createServerTaskStore(sqlite, sync);
const bindings = createServerTools(tasks);
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
    bindings: { ...bindings, system: composeSystem(prompts.current().persona) },
    ...targets.resolve("chat"),
  });
}
registerAgentRoutes(app, { engine: currentEngine, targets, prompts });

// Model Lab: fine-tuning, export, and benchmarking (docs/MODEL_LAB.md). Same
// gate as the agent routes.
registerLabRoutes(app, { store: createLabStore(sqlite), targets });

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
