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

/** What a client syncing from scratch would receive. */
const pullAll = () => sync.pull(0).rows;

describe("createTask", () => {
  // The failure this guards is silent: a row written without a rev is never
  // returned by pull (WHERE rev > ?), so the task exists on the server and is
  // invisible to every client forever, with no error raised anywhere.
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

  // Demonstrates the trap the store exists to avoid, so nobody "optimizes"
  // the push away later: a row inserted directly keeps rev NULL, and pull's
  // `WHERE rev > ?` silently never returns it.
  it("a direct insert bypassing push would be invisible to clients", () => {
    const db = new Database(":memory:");
    const bypassed = createTaskSyncStore(db);
    db.prepare(
      `INSERT INTO tasks (id, user_id, title, priority, status,
         created_at, updated_at)
       VALUES ('x', 'local', 'ghost row', 'medium', 'todo', '2026-01-01', '2026-01-01')`,
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
    // createdAt has second-or-better resolution; assert membership and that a
    // deleted row is absent rather than depending on same-millisecond ordering.
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

  // push() keeps the stored row when it is strictly newer, so an edit that
  // reused the old timestamp would be silently dropped.
  it("bumps updatedAt so the edit wins the LWW merge", () => {
    const t = store.createTask({ title: "x" });
    const updated = store.updateTask(t.id, { title: "y" });
    // ISO-8601 strings compare chronologically, which is what push() relies on.
    const after = updated?.updatedAt ?? "";
    expect(after >= t.updatedAt).toBe(true);
    expect(updated?.title).toBe("y");
  });
});

describe("deleteTask", () => {
  it("tombstones the row so the deletion syncs", () => {
    const t = store.createTask({ title: "x" });
    expect(store.deleteTask(t.id)).toBe(true);

    // The tombstone must reach clients — a hard delete would leave them holding
    // a task the server no longer has.
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
