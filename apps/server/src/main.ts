import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAgentRoutes } from "./agent/routes";
import { createServerTools } from "./agent/tools";
import { UnslothEngine } from "./agent/UnslothEngine";
import { sqlite } from "./db";
import { createServerTaskStore } from "./store/tasks";
import { createTaskSyncStore } from "./sync/store";
import { registerTaskSyncRoutes } from "./sync/tasks";

const app = Fastify({ logger: true });

// v0 has no auth (single user, LAN/localhost — see docs/SYNC.md), so reflect any
// origin. Lock this down before the server ever faces the open internet. The
// agent routes do not rely on this and carry their own gate (./agent/routes).
await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

// One sync store over the server's database, shared by the sync routes and the
// agent's task CRUD so both write through the same rev-assigning path.
const sync = createTaskSyncStore(sqlite);
registerTaskSyncRoutes(app, sync);

// Tier 1: the model runs here and executes tools in-process against the store,
// with no client in the turn loop (docs/UNSLOTH_TIER1_PLAN.md §2).
const tasks = createServerTaskStore(sqlite, sync);
registerAgentRoutes(app, {
  engine: new UnslothEngine({ bindings: createServerTools(tasks) }),
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
