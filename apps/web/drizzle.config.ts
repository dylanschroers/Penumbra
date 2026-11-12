import { defineConfig } from "drizzle-kit";

// The DB lives in OPFS, so this only generates SQL; the worker applies it.
export default defineConfig({
  dialect: "sqlite",
  schema: "../../packages/shared/src/schema/index.ts",
  out: "./src/db/migrations",
});
