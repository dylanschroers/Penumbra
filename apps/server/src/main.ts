// Must be first: populates process.env from apps/server/.env before any module
// below reads a credential at construction time.
import "./env";
import cors from "@fastify/cors";
import type { AgentEvent, ChatMessage, Engine } from "@penumbra/shared";
import Fastify from "fastify";
import { registerAgentRoutes } from "./agent/routes";
import { createServerTools } from "./agent/tools";
import { UnslothEngine } from "./agent/UnslothEngine";
import { sqlite } from "./db";
import { createCredentialStore } from "./lab/credentials";
import { createLabStore } from "./lab/jobs";
import { registerLabRoutes } from "./lab/routes";
import { StudioClient } from "./lab/studio";
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

// The local Studio's address and bearer. Environment first, overridden by
// anything set through /lab/provider/local — so rotating Studio's key is a form
// in the UI rather than an edit to .env and a restart.
const credentials = createCredentialStore(sqlite);

// Tier 1: the model runs here and executes tools in-process against the store,
// with no client in the turn loop (docs/SYNC.md → Server-side writes).
const tasks = createServerTaskStore(sqlite, sync);
const bindings = createServerTools(tasks);
const build = () => new UnslothEngine({ bindings, ...credentials.current() });
let engine = build();
credentials.onChange(() => {
  engine = build();
});

// Inference reads the engine the *current* credentials built. Without this
// indirection a key change would move training to the new Studio and leave chat
// talking to the old one — the split the StudioClient docs warn about.
const currentEngine: Engine = {
  getStatus: () => engine.getStatus(),
  runAgent: (messages: ChatMessage[], signal?: AbortSignal) =>
    engine.runAgent(messages, signal) as AsyncGenerator<AgentEvent>,
};
registerAgentRoutes(app, { engine: currentEngine });

// Model Lab: fine-tuning and benchmarking against the Studio on this host
// (docs/MODEL_LAB.md). Same gate as the agent routes.
registerLabRoutes(app, {
  store: createLabStore(sqlite),
  credentials,
  studio: new StudioClient(credentials.current()),
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
