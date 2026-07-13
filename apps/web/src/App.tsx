import { useEffect } from "react";
import "./app.css";
import { startSync } from "./sync/SyncClient";
import { Workspace } from "./workspace/Workspace";

// The app is now a blank workspace canvas. Features live as self-contained
// modules (see src/modules + the registry) that the user places, drags, and
// resizes on a snapping grid.
export function App() {
  // Sync runs only here: App mounts inside SingleTabGuard, so this is the one
  // tab that owns the local store. The cleanup stops the loop on unmount.
  useEffect(() => startSync(), []);

  return <Workspace />;
}
