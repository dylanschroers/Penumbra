import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SingleTabGuard } from "./SingleTabGuard";

declare global {
  interface Window {
    /** Installed by the boot watchdog in index.html. */
    __penumbraBooted?: () => void;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SingleTabGuard>
      <App />
    </SingleTabGuard>
  </StrictMode>,
);

// The static import graph loaded, so stand the watchdog down (index.html).
window.__penumbraBooted?.();
