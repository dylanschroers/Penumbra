import "./app.css";
import { Workspace } from "./workspace/Workspace";

// The app is now a blank workspace canvas. Features live as self-contained
// modules (see src/modules + the registry) that the user places, drags, and
// resizes on a snapping grid.
export function App() {
  return <Workspace />;
}
