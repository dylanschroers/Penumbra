import { toToolSpec } from "../tools/contract";
import { filesPolicy, fileTools } from "../tools/files";
import type { ClientTools, ToolBindings } from "./types";

/** An engine's bindings plus the tools a caller offered for this turn. Only
 *  names that match a shared file contract are advertised, so a caller can add
 *  folders to the prompt but never invent a tool. */
export function withClientTools(
  bindings: ToolBindings,
  client?: ClientTools,
): ToolBindings {
  const contracts = client
    ? fileTools.filter((t) => client.tools.includes(t.name))
    : [];
  if (!client || contracts.length === 0 || client.roots.length === 0) {
    return bindings;
  }
  const names = new Set<string>(contracts.map((t) => t.name));
  return {
    tools: [...bindings.tools, ...contracts.map(toToolSpec)],
    system: `${bindings.system} ${filesPolicy(client.roots)}`,
    runTool: (name, args) =>
      names.has(name)
        ? client.runTool(name, args)
        : bindings.runTool(name, args),
  };
}
