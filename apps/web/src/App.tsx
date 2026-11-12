import { useEffect } from "react";
import "./app.css";
import { AppShell } from "./shell/AppShell";
import { useTextScale } from "./shell/useTextScale";
import { startSync } from "./sync/SyncClient";

export function App() {
  // Sync runs only in the tab that owns the store (inside SingleTabGuard).
  useEffect(() => startSync(), []);
  useTextScale();

  return <AppShell />;
}
