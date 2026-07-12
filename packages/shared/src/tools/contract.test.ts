import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toToolSpec, type ToolContract } from "./contract";
import {
  taskTools,
  createTaskTool,
  listTasksTool,
} from "./tasks";

describe("toToolSpec", () => {
  it("wraps the contract in the OpenAI function-tool shape", () => {
    const spec = toToolSpec(listTasksTool);
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("list_tasks");
    expect(spec.function.description).toBe(listTasksTool.description);
  });

  it("derives the JSON Schema faithfully from the Zod args", () => {
    const params = toToolSpec(createTaskTool).function.parameters as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    // title is the only required field; the rest are optional/defaulted.
    expect(params.required).toEqual(["title"]);
    // .describe() text is carried through — it is what the model reads.
    expect(params.properties.title!.description).toBe("Short task title");
    // enum values and the default survive the derivation.
    expect(params.properties.priority!.enum).toEqual(["low", "medium", "high"]);
    expect(params.properties.priority!.default).toBe("medium");
  });

  // Regression: llama.cpp expands a maxLength bound into its decoding grammar
  // and rejects the request when the bound is large. toToolSpec strips bounds
  // over 1000 from the wire schema (Zod still enforces the real limit at the
  // call boundary). If stripHugeBounds is ever removed, these fail — with this
  // comment explaining why they exist.
  it("keeps small maxLength bounds but strips oversized ones", () => {
    const contract: ToolContract = {
      name: "t",
      description: "t",
      permission: "read",
      args: z.object({
        small: z.string().max(1000),
        big: z.string().max(1001),
      }),
    };
    const props = (
      toToolSpec(contract).function.parameters as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    expect(props.small!.maxLength).toBe(1000);
    expect(props.big!.maxLength).toBeUndefined();
  });

  it("strips the oversized notes bound on the real create_task contract", () => {
    const props = (
      toToolSpec(createTaskTool).function.parameters as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties;
    // title ≤ 200 is small and useful — kept; notes ≤ 10 000 is stripped.
    expect(props.title!.maxLength).toBe(200);
    expect(props.notes!.maxLength).toBeUndefined();
  });

  it("derives every shipped contract without throwing, with unique names", () => {
    const names = taskTools.map((c) => toToolSpec(c).function.name);
    expect(names).toEqual([
      "create_task",
      "list_tasks",
      "complete_task",
      "delete_task",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
