import type { TaskRow } from "@penumbra/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksCompact, TasksExpanded, TasksProvider } from "./TasksModule";

// The split-view contract (workspace/types.ts → SplitViewModule): the Provider
// is the one state owner, and the compact and expanded views are projections of
// it that can be on screen together. What must hold is that the two views cost
// one set of effects, not two, and never disagree — the failure this whole
// arrangement exists to prevent is a dock card and an expanded module showing
// different truths.

const db = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock("../../db/client", () => ({ getDb: () => db }));
vi.mock("../../sync/SyncClient", () => ({
  requestSync: vi.fn(),
  SYNC_EVENT: "penumbra:synced",
}));

const task = (
  id: string,
  title: string,
  status: TaskRow["status"],
  priority: TaskRow["priority"] = "medium",
): TaskRow => ({
  id,
  userId: "u",
  title,
  notes: null,
  priority,
  status,
  dueAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  rev: null,
});

let container: HTMLDivElement;
let root: Root;

/** Render and flush the provider's initial async load. */
const mount = async (ui: ReactNode) => {
  await act(async () => {
    root.render(ui);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Tasks split view", () => {
  it("renders both views from one state owner, loading the data once", async () => {
    db.listTasks.mockResolvedValue([
      task("1", "Write docs", "todo", "high"),
      task("2", "Ship it", "done"),
    ]);

    await mount(
      <TasksProvider>
        <TasksCompact />
        <TasksExpanded />
      </TasksProvider>,
    );

    // The compact view summarises; the expanded view lists.
    expect(container.textContent).toContain("1 open");
    expect(container.textContent).toContain("1 done");
    expect(container.querySelectorAll(".task")).toHaveLength(2);

    // The point of the Provider: two views, one load. Two mounted copies of the
    // module — what the shell did before — would fetch twice.
    expect(db.listTasks).toHaveBeenCalledTimes(1);
  });

  it("keeps the dock summary in step with an edit made in the expanded view", async () => {
    db.listTasks
      .mockResolvedValueOnce([task("1", "Write docs", "todo")])
      .mockResolvedValue([task("1", "Write docs", "done")]);

    await mount(
      <TasksProvider>
        <TasksCompact />
        <TasksExpanded />
      </TasksProvider>,
    );
    expect(container.textContent).toContain("1 open");

    // Complete the task from the expanded view's checkbox.
    await act(async () => {
      container.querySelector<HTMLInputElement>(".task__check")?.click();
    });

    expect(db.updateTask).toHaveBeenCalledWith("1", { status: "done" });
    // The compact view was never told anything — it reads the same state.
    expect(container.textContent).toContain("0 open");
    expect(container.textContent).toContain("1 done");
  });
});
