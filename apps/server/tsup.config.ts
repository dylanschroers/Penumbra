import { defineConfig } from "tsup";

// @penumbra/shared ships raw TypeScript (its entry is src/index.ts), which plain
// `node` cannot load, so it is bundled into dist rather than imported at runtime.
// Its own runtime imports (drizzle-orm, zod-to-json-schema, zod) stay external
// and resolve from this package's dependencies.
export default defineConfig({
  noExternal: ["@penumbra/shared"],
});
