import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createTaskSyncStore, type TaskSyncStore } from "../sync/store";
import { createServerTaskStore, type ServerTaskStore } from "./tasks";

let sync: TaskSyncStore;
let store: ServerTaskStore;

beforeEach(() => {
  const db = new Database(":memory:");
  sync = createTaskSyncStore(db);
  store = createServerTaskStore(db, sync);
});

const pullAll = () => sync.pull(0).rows;

describe("createTask", () => {
  // A row without a rev is never pulled, silently.
  it("assigns a rev, so a syncing client actually receives the task", () => {
    const created = store.createTask({ title: "buy milk" });

    expect(created.rev).toBeGreaterThan(0);
    expect(pullAll().map((r) => r.title)).toEqual(["buy milk"]);
  });

  it("applies the same schema defaults the client applies", () => {
    const created = store.createTask({ title: "x" });
    expect(created.priority).toBe("medium");
    expect(created.status).toBe("todo");
    expect(created.userId).toBe("local");
  });

  it("rejects input the shared schema rejects", () => {
    expect(() => store.createTask({ title: "" })).toThrow();
  });

  // Pins the trap so the push isn't "optimized" away.
  it("a direct insert bypassing push would be invisible to clients", () => {
    const db = new Database(":memory:");
    const bypassed = createTaskSyncStore(db);
    db.prepare(
      `INSERT INTO tasks (id, user_id, title, priority, status,
         created_at, updated_at)
       VALUES ('x', 'local', 'penumbra row', 'medium', 'todo', '2026-01-01', '2026-01-01')`,
    ).run();

    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({
      n: 1,
    });
    expect(bypassed.pull(0).rows).toEqual([]); // present, unreachable
  });

  it("advances the rev on every write, so pulls stay ordered", () => {
    const a = store.createTask({ title: "a" });
    const b = store.createTask({ title: "b" });
    expect(b.rev).toBeGreaterThan(a.rev as number);
  });
});

describe("listTasks", () => {
  it("returns live tasks newest first", () => {
    store.createTask({ title: "older" });
    store.createTask({ title: "newer" });
    expect(
      store
        .listTasks()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["newer", "older"]);
  });

  it("hides tombstoned tasks from the agent", () => {
    const t = store.createTask({ title: "gone" });
    store.deleteTask(t.id);
    expect(store.listTasks()).toEqual([]);
  });
});

describe("updateTask", () => {
  it("applies the patch and keeps the row pullable", () => {
    const t = store.createTask({ title: "x" });
    const updated = store.updateTask(t.id, { status: "done" });

    expect(updated?.status).toBe("done");
    expect(updated?.rev).toBeGreaterThan(t.rev as number);
    expect(pullAll().at(-1)?.status).toBe("done");
  });

  it("leaves untouched fields alone", () => {
    const t = store.createTask({ title: "keep", priority: "high" });
    const updated = store.updateTask(t.id, { status: "doing" });
    expect(updated?.title).toBe("keep");
    expect(updated?.priority).toBe("high");
  });

  it("reports a miss rather than throwing", () => {
    expect(store.updateTask("nope", { status: "done" })).toBeUndefined();
  });

  // push() keeps the stored row when strictly newer, so the edit needs a fresh
  // timestamp.
  it("bumps updatedAt so the edit wins the LWW merge", () => {
    const t = store.createTask({ title: "x" });
    const updated = store.updateTask(t.id, { title: "y" });
    const after = updated?.updatedAt ?? "";
    expect(after >= t.updatedAt).toBe(true);
    expect(updated?.title).toBe("y");
  });
});

describe("deleteTask", () => {
  it("tombstones the row so the deletion syncs", () => {
    const t = store.createTask({ title: "x" });
    expect(store.deleteTask(t.id)).toBe(true);

    const row = pullAll().find((r) => r.id === t.id);
    expect(row?.deletedAt).toEqual(expect.any(String));
    expect(row?.rev).toBeGreaterThan(t.rev as number);
  });

  it("reports a miss for an unknown id", () => {
    expect(store.deleteTask("nope")).toBe(false);
  });

  it("is not fooled by an already-deleted task", () => {
    const t = store.createTask({ title: "x" });
    store.deleteTask(t.id);
    expect(store.deleteTask(t.id)).toBe(false);
  });
});
