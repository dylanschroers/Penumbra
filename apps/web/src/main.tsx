import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SingleTabGuard } from "./SingleTabGuard";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SingleTabGuard>
      <App />
    </SingleTabGuard>
  </StrictMode>,
);
