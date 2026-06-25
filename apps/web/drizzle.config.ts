import { defineConfig } from "drizzle-kit";

// Generates SQL migrations for the *client* local store from the shared schema.
// The DB lives in the browser (OPFS), so there's no DB URL here — we only
// generate the SQL, then apply it inside the DB worker on startup.
export default defineConfig({
  dialect: "sqlite",
  schema: "../../packages/shared/src/schema/index.ts",
  out: "./src/db/migrations",
});
