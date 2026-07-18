/**
 * @vitest-environment node
 */
// End-to-end Plane A sync: real client stores (createTestDb) reconciling through
// the real server merge (createTaskSyncStore) over simulated rounds. Both merge
// implementations are the shipping code — only the round *sequence* is authored
// here, mirroring SyncClient.syncNow (apps/web/src/sync/SyncClient.ts) and
// docs/SYNC.md: push, then pull, then adopt-and-repush on an unfamiliar
// serverId. SyncClient's own wrapper (fetch, timers, status light) is
// browser-bound and stays covered by app runs, not this test.

import { createTaskSyncStore, type TaskSyncStore } from "@penumbra/server/sync";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbApi } from "../db/api";
import { createTestDb } from "../db/testing";

function makeServer(): TaskSyncStore {
  return createTaskSyncStore(new Database(":memory:"));
}

/** One sync round for a client against a server: push local changes, pull
 *  remote ones, and reconcile once more if the server is an unfamiliar epoch
 *  (including the first sync ever). Mirrors SyncClient.syncNow. */
async function sync(client: DbApi, server: TaskSyncStore): Promise<void> {
  const drainPush = async () => {
    const { seqs, rows } = await client.collectOutbox();
    if (rows.length) {
      server.push(rows);
      await client.clearOutbox(seqs);
    }
  };
  const pull = async (): Promise<string> => {
    const { rows, serverId } = server.pull(await client.getCursor());
    if (rows.length) await client.applyServerRows(rows);
    return serverId;
  };

  await drainPush();
  const serverId = await pull();

  if (serverId !== (await client.getServerId())) {
    await client.adoptServer(serverId);
    await drainPush();
    await pull();
  }
}

/** Live tasks reduced to comparable content, order-independent. */
async function snapshot(client: DbApi): Promise<string[]> {
  const tasks = await client.listTasks();
  return tasks.map((t) => `${t.title}:${t.status}:${t.priority}`).sort();
}

// createTask/updateTask/deleteTask stamp Date.now(); a fixed, advanceable clock
// makes the last-write-wins scenarios deterministic instead of millisecond-racy.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

/** Advance the shared fake clock. */
function tick(seconds: number): void {
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
}

describe("two-device convergence", () => {
  it("propagates a new task from one device to another", async () => {
    const server = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    await A.createTask({ title: "buy milk" });
    await sync(A, server);
    await sync(B, server);

    expect(await snapshot(B)).toEqual(["buy milk:todo:medium"]);
    expect(await snapshot(A)).toEqual(await snapshot(B));
  });

  it("merges independent creates from both devices", async () => {
    const server = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    await A.createTask({ title: "X" });
    await B.createTask({ title: "Y" });

    await sync(A, server); // push X, pull X
    await sync(B, server); // push Y, pull X + Y
    await sync(A, server); // pull Y

    const both = ["X:todo:medium", "Y:todo:medium"];
    expect(await snapshot(A)).toEqual(both);
    expect(await snapshot(B)).toEqual(both);
  });

  it("propagates a batch of offline edits in one round", async () => {
    const server = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    // A works offline: three creates, no sync in between.
    await A.createTask({ title: "one" });
    await A.createTask({ title: "two" });
    await A.createTask({ title: "three" });

    await sync(A, server); // a single round pushes all three
    await sync(B, server);

    expect(await snapshot(B)).toEqual([
      "one:todo:medium",
      "three:todo:medium",
      "two:todo:medium",
    ]);
  });
});

describe("last-write-wins across devices", () => {
  it("resolves a concurrent edit in favor of the newer write", async () => {
    const server = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    const t = await A.createTask({ title: "report" });
    await sync(A, server);
    await sync(B, server);

    tick(5);
    await B.updateTask(t.id, { status: "doing" }); // older edit
    tick(5);
    await A.updateTask(t.id, { status: "done" }); // newer edit

    await sync(B, server);
    await sync(A, server);
    await sync(B, server);

    expect(await snapshot(A)).toEqual(["report:done:medium"]);
    expect(await snapshot(B)).toEqual(["report:done:medium"]);
  });

  it("lets a newer edit revive a row deleted on another device", async () => {
    const server = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    const t = await A.createTask({ title: "revive me" });
    await sync(A, server);
    await sync(B, server);

    tick(5);
    await A.deleteTask(t.id); // delete
    tick(5);
    await B.updateTask(t.id, { title: "still here", status: "doing" }); // newer edit

    await sync(A, server); // push delete
    await sync(B, server); // push newer edit — revives
    await sync(A, server); // pull the revival

    expect(await snapshot(A)).toEqual(["still here:doing:medium"]);
    expect(await snapshot(B)).toEqual(["still here:doing:medium"]);
  });

  it("keeps a row deleted when the delete is the newer write", async () => {
    const server = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    const t = await A.createTask({ title: "goner" });
    await sync(A, server);
    await sync(B, server);

    tick(5);
    await B.updateTask(t.id, { status: "doing" }); // edit
    tick(5);
    await A.deleteTask(t.id); // newer delete

    await sync(B, server);
    await sync(A, server);
    await sync(B, server);

    expect(await snapshot(A)).toEqual([]);
    expect(await snapshot(B)).toEqual([]);
  });
});

describe("epochs", () => {
  it("re-seeds every device when the server database is replaced", async () => {
    const server1 = makeServer();
    const { api: A } = createTestDb();
    const { api: B } = createTestDb();

    await A.createTask({ title: "keep me" });
    await sync(A, server1);
    await sync(B, server1);
    expect(await snapshot(B)).toEqual(["keep me:todo:medium"]);

    // The database behind the same URL is replaced: a fresh, empty epoch.
    const server2 = makeServer();
    expect(server2.instanceId).not.toBe(server1.instanceId);

    // Each device sees an unfamiliar serverId, reconciles, and re-offers its
    // rows; last-write-wins makes the re-exchange converge.
    await sync(A, server2);
    await sync(B, server2);
    await sync(A, server2);

    const expected = ["keep me:todo:medium"];
    expect(await snapshot(A)).toEqual(expected);
    expect(await snapshot(B)).toEqual(expected);
    expect(await A.getServerId()).toBe(server2.instanceId);
    expect(await B.getServerId()).toBe(server2.instanceId);
  });
});
