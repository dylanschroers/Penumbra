import type { TaskRow } from "@ghost/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { requestSync } from "../sync/SyncClient";
import { runTool } from "./tools";

// tools.ts reaches for the real local store and the sync loop; both are
// replaced so runTool can be exercised in isolation. The mock factories are
// hoisted above the imports, so tools.ts loads against these fakes.
vi.mock("../db/client", () => ({ getDb: vi.fn() }));
vi.mock("../sync/SyncClient", () => ({
  requestSync: vi.fn(),
  SYNC_EVENT: "ghost:synced",
}));

const mockGetDb = vi.mocked(getDb);
const mockRequestSync = vi.mocked(requestSync);

/** A DbApi test double: every method a spy, overridable per test. */
function fakeDb(overrides: Record<string, unknown> = {}) {
  const db = {
    createTask: vi.fn(),
    listTasks: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    ...overrides,
  };
  mockGetDb.mockReturnValue(db as unknown as ReturnType<typeof getDb>);
  return db;
}

function task(partial: Partial<TaskRow>): TaskRow {
  return {
    id: "id",
    userId: "local",
    title: "",
    notes: null,
    priority: "medium",
    status: "todo",
    dueAt: null,
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
    rev: null,
    ...partial,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("runTool dispatch", () => {
  it("reports an unknown tool without touching the store", async () => {
    fakeDb();
    expect(await runTool("nope", {})).toBe("Unknown tool: nope");
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});

describe("argument validation", () => {
  it("returns the validation error and never runs on bad args", async () => {
    const db = fakeDb();
    const result = await runTool("create_task", {}); // title is required
    expect(result).toMatch(/^Invalid arguments for create_task/);
    expect(db.createTask).not.toHaveBeenCalled();
    expect(mockRequestSync).not.toHaveBeenCalled();
  });
});

describe("create_task", () => {
  it("applies schema defaults, writes, and nudges the UI + sync", async () => {
    const db = fakeDb({
      createTask: vi.fn().mockResolvedValue(task({ title: "buy milk" })),
    });

    let synced = false;
    const onSync = () => (synced = true);
    window.addEventListener("ghost:synced", onSync);
    const result = await runTool("create_task", { title: "buy milk" });
    window.removeEventListener("ghost:synced", onSync);

    // priority defaulted by the Zod schema, not the runner.
    expect(db.createTask).toHaveBeenCalledWith({
      title: "buy milk",
      priority: "medium",
      dueAt: undefined,
      notes: undefined,
    });
    expect(result).toContain('Created task "buy milk"');
    // The bucket-2 fix: a write both refreshes the UI and pushes immediately.
    expect(synced).toBe(true);
    expect(mockRequestSync).toHaveBeenCalledOnce();
  });

  it("coerces a parseable due date to ISO and drops an unparseable one", async () => {
    const db = fakeDb({
      createTask: vi.fn().mockResolvedValue(task({ title: "x" })),
    });

    await runTool("create_task", { title: "x", dueAt: "2026-01-15" });
    expect(db.createTask.mock.calls[0]![0].dueAt).toBe(
      new Date("2026-01-15").toISOString(),
    );

    await runTool("create_task", { title: "x", dueAt: "whenever" });
    expect(db.createTask.mock.calls[1]![0].dueAt).toBeUndefined();
  });

  it("returns a failure string when the store throws", async () => {
    fakeDb({ createTask: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(await runTool("create_task", { title: "x" })).toBe(
      "Tool create_task failed: boom",
    );
  });
});

describe("list_tasks", () => {
  it("formats the list and does not trigger a sync (read-only)", async () => {
    fakeDb({
      listTasks: vi
        .fn()
        .mockResolvedValue([
          task({ title: "a", status: "todo", priority: "high" }),
        ]),
    });
    const result = await runTool("list_tasks", {});
    expect(result).toContain("- a [todo, high]");
    expect(mockRequestSync).not.toHaveBeenCalled();
  });
});

describe("complete_task title matching", () => {
  it("prefers an exact title match over a substring, case-insensitively", async () => {
    const db = fakeDb({
      listTasks: vi
        .fn()
        .mockResolvedValue([
          task({ id: "long", title: "buy milk and eggs" }),
          task({ id: "exact", title: "buy milk" }),
        ]),
      updateTask: vi.fn().mockResolvedValue(task({ id: "exact" })),
    });
    await runTool("complete_task", { title: "BUY MILK" });
    expect(db.updateTask).toHaveBeenCalledWith("exact", { status: "done" });
  });

  it("falls back to a substring match when there is no exact one", async () => {
    const db = fakeDb({
      listTasks: vi
        .fn()
        .mockResolvedValue([task({ id: "long", title: "buy milk and eggs" })]),
      updateTask: vi.fn().mockResolvedValue(task({ id: "long" })),
    });
    await runTool("complete_task", { title: "eggs" });
    expect(db.updateTask).toHaveBeenCalledWith("long", { status: "done" });
  });

  it("reports no match without writing", async () => {
    const db = fakeDb({ listTasks: vi.fn().mockResolvedValue([]) });
    expect(await runTool("complete_task", { title: "ghost" })).toBe(
      'No task matching "ghost".',
    );
    expect(db.updateTask).not.toHaveBeenCalled();
  });
});
