import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Contracts are shared; implementations are per runtime because `run` is
// platform-bound.

/** Unenforced; the hook for autonomous-mode scopes and an audit log. */
export type ToolPermission = "read" | "write" | "act";

export interface ToolContract<Args extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  permission: ToolPermission;
  args: Args;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

// llama.cpp expands bounded string repetitions into its grammar and rejects the
// request above ~1000 (fails at 2000). Zod still enforces the real limit.
const GRAMMAR_MAX_LENGTH = 1000;

function stripHugeBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripHugeBounds(item);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.maxLength === "number" &&
      obj.maxLength > GRAMMAR_MAX_LENGTH
    ) {
      delete obj.maxLength;
    }
    for (const value of Object.values(obj)) stripHugeBounds(value);
  }
}

export function toToolSpec(contract: ToolContract): ToolSpec {
  const parameters = zodToJsonSchema(contract.args, { target: "openApi3" });
  stripHugeBounds(parameters);
  return {
    type: "function",
    function: {
      name: contract.name,
      description: contract.description,
      parameters,
    },
  };
}
