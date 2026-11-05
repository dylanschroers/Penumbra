import { AgentModule } from "../modules/agent/AgentModule";
import { ColorPickerModule } from "../modules/color/ColorPickerModule";
import { PaintExpanded } from "../modules/color/paint/PaintModule";
import { PaintProvider } from "../modules/color/paint/PaintProvider";
import { LabModule } from "../modules/lab/LabModule";
import {
  TasksCompact,
  TasksExpanded,
  TasksProvider,
} from "../modules/tasks/TasksModule";
import { WeatherModule } from "../modules/weather/WeatherModule";
import type { ModuleDefinition } from "./types";

// The module registry. Adding a future module (weather, notes, …) is one entry
// here plus its component — the shell's dock and its "add module" card pick it
// up automatically. The shell sizes modules from CSS, so an entry carries no
// geometry.
//
// An entry takes one of two shapes (see ./types): a single `Component` that the
// shell moves between the dock and the centre, or the split `Provider` +
// `Compact` + `Expanded`, which keeps a live dock summary alongside the
// expanded module. Tasks and Paint use the split; the rest are still single-view
// and get converted as their compact designs land.
export const MODULES: ModuleDefinition[] = [
  {
    id: "tasks",
    title: "Tasks",
    Provider: TasksProvider,
    Compact: TasksCompact,
    Expanded: TasksExpanded,
  },
  {
    // Still "color": it is the key saved layouts reopen this module by.
    id: "color",
    title: "Paint",
    Provider: PaintProvider,
    Compact: ColorPickerModule,
    Expanded: PaintExpanded,
  },
  { id: "weather", title: "Weather", Component: WeatherModule },
  { id: "lab", title: "Model Lab", Component: LabModule },
  { id: "agent", title: "Assistant", Component: AgentModule },
];

/** Look up a module definition by id. */
export function getModule(id: string): ModuleDefinition | undefined {
  return MODULES.find((m) => m.id === id);
}
