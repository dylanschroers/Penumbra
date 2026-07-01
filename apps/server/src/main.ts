import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerTaskSyncRoutes } from "./sync/tasks";
import "./db"; // open the store + ensure schema on startup

const app = Fastify({ logger: true });

// v0 has no auth (single user, LAN/localhost — see docs/SYNC.md), so reflect any
// origin. Lock this down before the server ever faces the open internet.
await app.register(cors, { origin: true });

app.get("/health", async () => ({ status: "ok" }));

registerTaskSyncRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
