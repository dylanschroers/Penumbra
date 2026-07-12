/**
 * @vitest-environment node
 */
// The storage-agnostic DbApi against a real in-memory SQLite (via ./testing).
// Every test starts from a freshly migrated store, so these also exercise the
// migrations end to end. No DOM here — plain Node is faster and more honest.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SyncTask } from "@ghost/shared";
import { createTestDb } from "./testing";

// A full sync-wire row with sensible defaults; override what a test cares about.
function syncRow(partial: Partial<SyncTask> & { id: string }): SyncTask {
  return {
    userId: "local",
    title: "task",
    notes: null,
    priority: "medium",
    status: "todo",
    dueAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    rev: 1,
    ...partial,
  };
}

// createTask/updateTask stamp Date.now(); a fixed, advanceable clock makes
// ordering and updatedAt comparisons deterministic instead of millisecond-racy.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("task CRUD", () => {
  it("creates a row with defaults and returns it", async () => {
    const { api } = createTestDb();
    const t = await api.createTask({ title: "buy milk" });
    expect(t).toMatchObject({
      title: "buy milk",
      userId: "local",
      priority: "medium",
      status: "todo",
    });
    expect(t.id).toBeTruthy();
    expect(t.deletedAt).toBeNull();
    expect(t.rev).toBeNull();
  });

  it("rejects invalid input at the schema boundary", async () => {
    const { api } = createTestDb();
    await expect(api.createTask({ title: "" })).rejects.toThrow();
  });

  it("lists live tasks newest-first and excludes soft-deleted ones", async () => {
    const { api } = createTestDb();
    const a = await api.createTask({ title: "a" });
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    await api.createTask({ title: "b" });

    expect((await api.listTasks()).map((t) => t.title)).toEqual(["b", "a"]);

    await api.deleteTask(a.id);
    expect((await api.listTasks()).map((t) => t.title)).toEqual(["b"]);
  });

  it("updates a patch, bumps updatedAt, and throws on a missing id", async () => {
    const { api } = createTestDb();
    const t = await api.createTask({ title: "x" });
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    const u = await api.updateTask(t.id, { status: "done" });

    expect(u.status).toBe("done");
    expect(u.updatedAt > t.updatedAt).toBe(true);
    await expect(api.updateTask("nope", { status: "done" })).rejects.toThrow(
      "Task not found: nope",
    );
  });

  it("soft-deletes with a tombstone rather than removing the row", async () => {
    const { db, api } = createTestDb();
    const t = await api.createTask({ title: "x" });
    await api.deleteTask(t.id);

    expect(await api.listTasks()).toHaveLength(0);
    const row = db
      .prepare("SELECT deleted_at AS d FROM tasks WHERE id = ?")
      .get(t.id) as { d: string | null };
    expect(row.d).not.toBeNull();
  });

  it("treats deleting a missing id as a no-op", async () => {
    const { api } = createTestDb();
    await expect(api.deleteTask("nope")).resolves.toBeUndefined();
    expect((await api.collectOutbox()).seqs).toHaveLength(0);
  });
});

describe("outbox bookkeeping", () => {
  it("enqueues every local mutation", async () => {
    const { api } = createTestDb();
    const t = await api.createTask({ title: "x" });
    const { seqs, rows } = await api.collectOutbox();
    expect(seqs).toHaveLength(1);
    expect(rows[0]!.id).toBe(t.id);
  });

  it("dedupes row ids but keeps every seq", async () => {
    const { api } = createTestDb();
    const t = await api.createTask({ title: "x" });
    await api.updateTask(t.id, { status: "doing" });
    await api.updateTask(t.id, { status: "done" });

    const { seqs, rows } = await api.collectOutbox();
    expect(seqs).toHaveLength(3); // create + two updates
    expect(rows).toHaveLength(1); // one distinct row
  });

  // The core "no edit is ever lost" guarantee from docs/SYNC.md: a mutation
  // that lands after collect but before clear has a higher seq and survives.
  it("keeps a mutation that lands mid-push", async () => {
    const { api } = createTestDb();
    await api.createTask({ title: "a" });
    const { seqs } = await api.collectOutbox(); // the push collects only these
    const b = await api.createTask({ title: "b" }); // lands mid-push
    await api.clearOutbox(seqs); // clear only what was collected

    const after = await api.collectOutbox();
    expect(after.rows.map((r) => r.id)).toEqual([b.id]);
  });
});

describe("last-write-wins (applyServerRows)", () => {
  it("accepts a strictly newer incoming row", async () => {
    const { api } = createTestDb();
    await api.applyServerRows([
      syncRow({ id: "1", title: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const changed = await api.applyServerRows([
      syncRow({ id: "1", title: "new", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(changed).toBe(1);
    expect((await api.listTasks())[0]!.title).toBe("new");
  });

  it("ignores a strictly older incoming row", async () => {
    const { api } = createTestDb();
    await api.applyServerRows([
      syncRow({ id: "1", title: "current", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    const changed = await api.applyServerRows([
      syncRow({ id: "1", title: "stale", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(changed).toBe(0);
    expect((await api.listTasks())[0]!.title).toBe("current");
  });

  it("resolves an updatedAt tie in favor of the incoming (server) row", async () => {
    const { api } = createTestDb();
    const t = "2026-01-01T00:00:00.000Z";
    await api.applyServerRows([syncRow({ id: "1", title: "first", updatedAt: t })]);
    const changed = await api.applyServerRows([
      syncRow({ id: "1", title: "second", updatedAt: t }),
    ]);
    expect(changed).toBe(1);
    expect((await api.listTasks())[0]!.title).toBe("second");
  });

  it("propagates a server tombstone as a local delete", async () => {
    const { api } = createTestDb();
    await api.applyServerRows([
      syncRow({ id: "1", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(await api.listTasks()).toHaveLength(1);

    await api.applyServerRows([
      syncRow({
        id: "1",
        updatedAt: "2026-01-02T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    expect(await api.listTasks()).toHaveLength(0);
  });

  it("never re-enqueues pulled rows into the outbox", async () => {
    const { api } = createTestDb();
    await api.applyServerRows([syncRow({ id: "1" })]);
    expect((await api.collectOutbox()).seqs).toHaveLength(0);
  });
});

describe("epochs (adoptServer / cursor)", () => {
  it("reports the pull cursor as the highest stored rev", async () => {
    const { api } = createTestDb();
    expect(await api.getCursor()).toBe(0);
    await api.applyServerRows([
      syncRow({ id: "1", rev: 3 }),
      syncRow({ id: "2", rev: 7 }),
    ]);
    expect(await api.getCursor()).toBe(7);
  });

  it("has no adopted server id until it reconciles", async () => {
    const { api } = createTestDb();
    expect(await api.getServerId()).toBeNull();
  });

  it("reconciles a new epoch: nulls revs, re-enqueues all rows, stores the id", async () => {
    const { api } = createTestDb();
    await api.applyServerRows([
      syncRow({ id: "1", rev: 5, updatedAt: "2026-01-01T00:00:00.000Z" }),
      syncRow({
        id: "2",
        rev: 6,
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    expect((await api.collectOutbox()).seqs).toHaveLength(0); // pulled, clean

    await api.adoptServer("server-abc");

    expect(await api.getServerId()).toBe("server-abc");
    expect(await api.getCursor()).toBe(0); // revs nulled
    const { rows } = await api.collectOutbox();
    // Every row re-offered, tombstone (id "2") included.
    expect(rows.map((r) => r.id).sort()).toEqual(["1", "2"]);
  });

  it("overwrites the stored id on a later adoption", async () => {
    const { api } = createTestDb();
    await api.adoptServer("first");
    await api.adoptServer("second");
    expect(await api.getServerId()).toBe("second");
  });
});
