import { useEffect } from "react";
import "./app.css";
import { AppShell } from "./shell/AppShell";
import { startSync } from "./sync/SyncClient";

// UI-overhaul prototype: the app now boots into the launcher shell (logo →
// assistant → module dock/focus). The previous free-grid Workspace still lives
// in src/workspace and can be swapped back here while we evaluate the direction.
export function App() {
  // Sync runs only here: App mounts inside SingleTabGuard, so this is the one
  // tab that owns the local store. The cleanup stops the loop on unmount.
  useEffect(() => startSync(), []);

  return <AppShell />;
}
