import type { ModuleDefinition } from "./types";
import { TasksModule } from "../modules/tasks/TasksModule";

// The module registry. Adding a future module (weather, notes, …) is one entry
// here plus its component — the canvas, the "add module" menu, and persistence
// all pick it up automatically.
export const MODULES: ModuleDefinition[] = [
  {
    id: "tasks",
    title: "Tasks",
    // Widths are in 24-col units (see COLS in Workspace.tsx): 8/24 == a third of
    // the canvas, same as the old 4/12, but it can now snap at half-column steps.
    defaultSize: { w: 8, h: 6 },
    minSize: { w: 6, h: 3 },
    Component: TasksModule,
  },
];

/** Look up a module definition by id. */
export function getModule(id: string): ModuleDefinition | undefined {
  return MODULES.find((m) => m.id === id);
}
