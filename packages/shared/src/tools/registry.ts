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
// export rather than the tiers quietly diverging.

/** Every contract the agent advertises, in the order the model sees them. */
export const agentTools = [...taskTools, getWeatherTool] as const;
