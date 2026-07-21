import type { ToolBindings } from "@penumbra/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerTaskStore, type ServerTaskStore } from "../store/tasks";
import { createTaskSyncStore } from "../sync/store";
import { createServerTools } from "./tools";

// These run against a real in-memory store rather than a mock, so a tool that
// writes a row the sync layer would reject fails here.
let store: ServerTaskStore;
let run: ToolBindings["runTool"];

beforeEach(() => {
  const db = new Database(":memory:");
  store = createServerTaskStore(db, createTaskSyncStore(db));
  run = createServerTools(store).runTool;
});

describe("dispatch", () => {
  it("reports an unknown tool instead of throwing", async () => {
    expect(await run("nope", {})).toBe("Unknown tool: nope");
  });

  // The model sees the failure text and can usually correct itself next step,
  // which is why this is a returned string and not an exception.
  it("returns validation failures as readable text", async () => {
    const result = await run("create_task", {}); // title is required
    expect(result).toContain("Invalid arguments for create_task");
    expect(result).toContain("title");
  });

  it("advertises exactly the shared contracts", () => {
    const { tools } = createServerTools(store);
    expect(tools.map((t) => t.function.name).sort()).toEqual([
      "complete_task",
      "create_task",
      "delete_task",
      "list_tasks",
    ]);
  });
});

describe("create_task", () => {
  it("writes a task the store can list", async () => {
    const result = await run("create_task", { title: "buy milk" });
    expect(result).toBe('Created task "buy milk" (medium priority).');
    expect(store.listTasks().map((t) => t.title)).toEqual(["buy milk"]);
  });

  // A live model invented "2023-10-15T12:00:00Z" for a request with no date at
  // all (AGENT_DESIGN.md §7). Garbage must not reach the store's schema.
  it("drops an unparseable date rather than failing the write", async () => {
    await run("create_task", { title: "x", dueAt: "whenever" });
    expect(store.listTasks()[0]?.dueAt).toBeNull();
  });

  it("normalizes a parseable date to ISO", async () => {
    await run("create_task", { title: "x", dueAt: "2026-01-15" });
    expect(store.listTasks()[0]?.dueAt).toBe("2026-01-15T00:00:00.000Z");
  });
});

describe("list_tasks", () => {
  it("summarizes tasks for the model", async () => {
    await run("create_task", { title: "a", priority: "high" });
    expect(await run("list_tasks", {})).toBe("- a [todo, high]");
  });

  it("filters by status", async () => {
    await run("create_task", { title: "a" });
    await run("create_task", { title: "b" });
    await run("complete_task", { title: "a" });
    expect(await run("list_tasks", { status: "done" })).toBe(
      "- a [done, medium]",
    );
  });

  it("says so when there is nothing to report", async () => {
    expect(await run("list_tasks", {})).toBe("No matching tasks.");
  });
});

describe("complete_task and delete_task", () => {
  it("matches a title case-insensitively", async () => {
    await run("create_task", { title: "buy milk" });
    expect(await run("complete_task", { title: "BUY MILK" })).toBe(
      'Marked "buy milk" as done.',
    );
    expect(store.listTasks()[0]?.status).toBe("done");
  });

  it("falls back to a partial title match", async () => {
    await run("create_task", { title: "buy oat milk today" });
    await run("complete_task", { title: "oat milk" });
    expect(store.listTasks()[0]?.status).toBe("done");
  });

  it("reports a miss without touching anything", async () => {
    await run("create_task", { title: "keep" });
    expect(await run("complete_task", { title: "penumbra" })).toBe(
      'No task matching "penumbra".',
    );
    expect(store.listTasks()[0]?.status).toBe("todo");
  });

  it("tombstones on delete so the deletion syncs", async () => {
    await run("create_task", { title: "gone" });
    expect(await run("delete_task", { title: "gone" })).toBe('Deleted "gone".');
    expect(store.listTasks()).toEqual([]);
  });
});
