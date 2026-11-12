import type { TaskRow } from "@penumbra/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TasksCompact, TasksExpanded, TasksProvider } from "./TasksModule";

// The Provider is the single state owner; both views must cost one set of
// effects and never disagree.

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

    expect(container.textContent).toContain("1 open");
    expect(container.textContent).toContain("1 done");
    expect(container.querySelectorAll(".task")).toHaveLength(2);

    // Two views, one load.
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

    await act(async () => {
      container.querySelector<HTMLInputElement>(".task__check")?.click();
    });

    expect(db.updateTask).toHaveBeenCalledWith("1", { status: "done" });
    expect(container.textContent).toContain("0 open");
    expect(container.textContent).toContain("1 done");
  });
});
