import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SingleTabGuard } from "./SingleTabGuard";

declare global {
  interface Window {
    /** Installed by the boot watchdog in index.html; called once below to stand
     *  its one-shot reload down. */
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

// Reaching here means the whole static import graph behind this entry loaded, so
// the failure the watchdog guards against — a module served with the wrong MIME
// type, blanking the page before render — did not happen. Stand it down so it
// never reloads a session that actually came up. See index.html.
window.__penumbraBooted?.();
