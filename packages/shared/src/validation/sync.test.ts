import { describe, it, expect } from "vitest";
import { syncTask } from "./sync";
import { createTaskInput, updateTaskInput } from "./task";

describe("syncTask wire schema", () => {
  const fullRow = {
    id: "1",
    userId: "local",
    title: "buy milk",
    priority: "medium",
    status: "todo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    notes: null,
    dueAt: null,
    deletedAt: null,
    rev: null,
  };

  // A sync row is a *stored* row: SQLite hands back NULL, not `undefined`, for
  // empty optional columns. The schema must accept null on notes/dueAt/rev or
  // the server rejects every task with no notes / no due date.
  it("accepts null for the nullable stored columns", () => {
    expect(syncTask.safeParse(fullRow).success).toBe(true);
  });

  it("accepts a tombstoned (deleted) row carrying its full data", () => {
    const deleted = { ...fullRow, deletedAt: "2026-01-02T00:00:00.000Z", rev: 5 };
    expect(syncTask.safeParse(deleted).success).toBe(true);
  });
});

describe("task input schemas", () => {
  // createTaskInput fills defaults (a create needs a complete row)...
  it("defaults priority to medium on create", () => {
    const parsed = createTaskInput.parse({ title: "x" });
    expect(parsed.priority).toBe("medium");
  });

  // ...but updateTaskInput injects nothing, so an omitted field means "leave
  // unchanged" rather than "reset to the default".
  it("injects no defaults on update", () => {
    expect(updateTaskInput.parse({})).toEqual({});
  });

  it("rejects an empty title", () => {
    expect(createTaskInput.safeParse({ title: "" }).success).toBe(false);
  });
});
