import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // react-draggable (used by react-grid-layout) gates a debug log on
  // `process.env.DRAGGABLE_DEBUG`. `process` doesn't exist in the browser, so
  // without this it throws "process is not defined" the moment a drag/resize
  // starts. Define the value so the dead branch compiles away.
  define: {
    "process.env.DRAGGABLE_DEBUG": "false",
  },
  // strictPort: the Tauri shell hardcodes this port as its devUrl, so failing
  // fast beats Vite silently hopping to 5174 and leaving the webview dead.
  server: { port: 5173, strictPort: true },
  // The worker is an ES module (it uses import/export).
  worker: { format: "es" },
  optimizeDeps: {
    // Don't pre-bundle sqlite-wasm: it ships a .wasm asset that Vite must serve
    // as-is, and pre-bundling can detach the .js from its .wasm.
    exclude: ["@sqlite.org/sqlite-wasm"],
    // The top-level `define` above doesn't reach already pre-bundled deps in
    // dev, so inject the same replacement into the dependency optimizer. This is
    // what actually fixes react-draggable's drag-time crash during `vite dev`.
    esbuildOptions: {
      define: { "process.env.DRAGGABLE_DEBUG": "false" },
    },
  },
});
