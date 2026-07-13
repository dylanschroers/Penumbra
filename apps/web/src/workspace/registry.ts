import { AgentModule } from "../modules/agent/AgentModule";
import { ColorPickerModule } from "../modules/color/ColorPickerModule";
import { TasksModule } from "../modules/tasks/TasksModule";
import { WeatherModule } from "../modules/weather/WeatherModule";
import type { ModuleDefinition } from "./types";

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
  {
    id: "color",
    title: "Color Picker",
    // Sized to fit the static 180px wheel plus the slider and hex row.
    defaultSize: { w: 6, h: 9 },
    minSize: { w: 5, h: 8 },
    Component: ColorPickerModule,
  },
  {
    id: "weather",
    title: "Weather",
    defaultSize: { w: 7, h: 8 },
    minSize: { w: 6, h: 7 },
    Component: WeatherModule,
  },
  {
    id: "agent",
    title: "Assistant",
    defaultSize: { w: 8, h: 10 },
    minSize: { w: 6, h: 7 },
    Component: AgentModule,
  },
];

/** Look up a module definition by id. */
export function getModule(id: string): ModuleDefinition | undefined {
  return MODULES.find((m) => m.id === id);
}
