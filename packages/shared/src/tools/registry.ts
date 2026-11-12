import {
  jobStatusTool,
  labHistoryTool,
  listDatasetsTool,
  listModelsTool,
  runBenchmarkTool,
  startFinetuneTool,
} from "./lab";
import { taskTools } from "./tasks";
import { getWeatherTool } from "./weather";

export const agentTools = [...taskTools, getWeatherTool] as const;

/** Server-only: they need the job store and a Studio on this host. */
export const labTools = [
  listModelsTool,
  listDatasetsTool,
  startFinetuneTool,
  runBenchmarkTool,
  jobStatusTool,
  labHistoryTool,
] as const;
