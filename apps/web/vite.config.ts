import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The worker is an ES module (it uses import/export).
  worker: { format: "es" },
  // Don't pre-bundle sqlite-wasm: it ships a .wasm asset that Vite must serve
  // as-is, and pre-bundling can detach the .js from its .wasm.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
