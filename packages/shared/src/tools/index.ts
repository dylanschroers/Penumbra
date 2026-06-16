import type { z } from "zod";

// Seed of the tool registry (docs/ARCHITECTURE.md → "The tool registry is the
// spine"). A capability is defined once here and invoked by BOTH the REST API
// (a human pulled the trigger) and the agent (the model pulled the trigger).

/** Permission tiers a tool can require. */
export type ToolPermission = "read" | "write" | "act";

/**
 * One capability the app exposes. `args` is a Zod schema, so the very same
 * definition validates human input and model-generated tool calls.
 */
export interface ToolDefinition<Args extends z.ZodTypeAny, Result> {
  name: string;
  description: string;
  permission: ToolPermission;
  args: Args;
  run: (args: z.infer<Args>) => Promise<Result>;
}
