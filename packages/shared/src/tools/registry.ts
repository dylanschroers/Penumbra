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

// The one list of contracts the agent advertises.
//
// It exists because four things have to agree about the tool set and had been
// agreeing only by each importing `taskTools`: the Tier-0 bindings
// (apps/web/src/agent/tools.ts), the Tier-1 bindings
// (apps/server/src/agent/tools.ts), the eval set (../eval/cases.ts), and the
// policy half of the system prompt, which tells the model what the tools are
// for. Adding a tool to `taskTools` to reach all of them would have made the
// name a lie; adding it to some of them is how a tier ends up advertising a
// tool it cannot run.
//
// Both tiers bind every contract here. A tool only one tier can run would need
// its own list, and that is the point at which this file should grow a second
// export rather than the tiers quietly diverging. `labTools` below is that
// second list.

/** Every contract the agent advertises, in the order the model sees them. */
export const agentTools = [...taskTools, getWeatherTool] as const;

/**
 * The Model Lab contracts, which only the server tier can run.
 *
 * Separate from `agentTools` because running one needs the job store, the
 * compute targets, and a Studio on this host — none of which exist in a
 * browser, so Tier 0 could only advertise these and then fail every call. The
 * server binds both lists (apps/server/src/agent/tools.ts); Tier 0 binds
 * `agentTools` alone, which also keeps the eval harness and the personal
 * benchmark suite measuring the same five tools they always have.
 *
 * Reads first, then the two that start work, then the two that report back —
 * one on work in flight, one on work that finished. Roughly the order a turn
 * needs them.
 */
export const labTools = [
  listModelsTool,
  listDatasetsTool,
  startFinetuneTool,
  runBenchmarkTool,
  jobStatusTool,
  labHistoryTool,
] as const;
