import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// The tool registry's shared half (docs/ARCHITECTURE.md → "The tool registry is
// the spine"). A capability's *contract* — name, description, permission, and
// its Zod argument schema — is defined once here and consumed everywhere:
//   - clients derive the model-facing JSON Schema from it (toToolSpec) and
//     validate model-emitted arguments against it before running anything;
//   - the eval harness (scripts/tool-eval.ts) tests exactly these specs;
//   - the server agent later binds the same contracts to its own store.
// Implementations are deliberately NOT here: a `run` function is platform-bound
// (today's tools touch the client's local store), so each runtime pairs a
// contract with its own runner.

/** Permission tiers a tool can require. Unenforced today; recorded on every
 * contract so the autonomous-mode permission scopes (docs/AGENT_DESIGN.md §8)
 * and the server-side audit hook have something to key on when they land. */
export type ToolPermission = "read" | "write" | "act";

/** One capability's contract: everything about a tool except how to run it. */
export interface ToolContract<Args extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  permission: ToolPermission;
  /** Argument schema. Validates model-emitted calls at the boundary, and is
   * the single source the model-facing JSON Schema is derived from. */
  args: Args;
}

/** A tool as the OpenAI-compatible chat API expects it (the `tools` array). */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

// llama.cpp compiles the JSON Schema into a decoding grammar and expands
// bounded string repetitions while doing it, so a large maxLength (measured:
// fine at 1000, "failed to parse grammar" at 2000) makes it reject the whole
// request. Bounds that big add nothing at generation time anyway — the Zod
// schema still enforces the real limit when the call is validated — so strip
// them from the wire schema and keep the small, useful ones (e.g. title ≤ 200).
const GRAMMAR_MAX_LENGTH = 1000;

function stripHugeBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripHugeBounds(item);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.maxLength === "number" && obj.maxLength > GRAMMAR_MAX_LENGTH) {
      delete obj.maxLength;
    }
    for (const value of Object.values(obj)) stripHugeBounds(value);
  }
}

/** Derive the wire spec from a contract. The JSON Schema is generated from the
 * Zod schema, so enums, lengths, and descriptions can never drift from what
 * the runtime actually validates — and llama-server's grammar-constrained
 * decoding enforces the same shape at generation time (AGENT_DESIGN.md §7). */
export function toToolSpec(contract: ToolContract): ToolSpec {
  // openApi3 target: plain nested schemas, no $schema/$ref noise.
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
