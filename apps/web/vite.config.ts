import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // happy-dom so code touching `window` runs without a browser.
  test: {
    environment: "happy-dom",
  },
  // Tauri hardcodes this port as its devUrl.
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  optimizeDeps: {
    // Pre-bundling can detach the .js from its .wasm.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
