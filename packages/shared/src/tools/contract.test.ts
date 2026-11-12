import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ToolContract, toToolSpec } from "./contract";
import { agentTools } from "./registry";
import { createTaskTool, listTasksTool } from "./tasks";

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
    expect(params.required).toEqual(["title"]);
    expect(params.properties.title!.description).toBe("Short task title");
    expect(params.properties.priority!.enum).toEqual(["low", "medium", "high"]);
    expect(params.properties.priority!.default).toBe("medium");
  });

  // llama.cpp rejects requests with large maxLength bounds; toToolSpec strips
  // them from the wire schema.
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
    expect(props.title!.maxLength).toBe(200);
    expect(props.notes!.maxLength).toBeUndefined();
  });

  it("derives every shipped contract without throwing, with unique names", () => {
    const names = agentTools.map((c) => toToolSpec(c).function.name);
    expect(names).toEqual([
      "create_task",
      "list_tasks",
      "complete_task",
      "delete_task",
      "get_weather",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
