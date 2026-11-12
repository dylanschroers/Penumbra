import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizeHandles } from "./ResizeHandles";

// With `decorations: false` these grips are the only way to resize, and their
// failures are silent. Direction is read from `data-direction`, not the class.

const win = vi.hoisted(() => ({
  startResizeDragging: vi.fn(),
  isMaximized: vi.fn(),
  onResized: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

let container: HTMLDivElement;
let root: Root;
let onResized: (() => void) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  onResized = undefined;
  unlisten = vi.fn();
  win.startResizeDragging.mockResolvedValue(undefined);
  win.isMaximized.mockResolvedValue(false);
  win.onResized.mockImplementation(async (handler: () => void) => {
    onResized = handler;
    return unlisten;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<ResizeHandles />);
  });
}

const grips = () => [
  ...container.querySelectorAll<HTMLElement>(".resize-grip"),
];

const directions = () => grips().map((g) => g.dataset.direction);

function press(direction: string, button = 0) {
  const grip = grips().find((g) => g.dataset.direction === direction);
  expect(grip, `no grip for ${direction}`).toBeTruthy();
  act(() => {
    grip?.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button }),
    );
  });
}

describe("resize grips", () => {
  it("covers all eight directions", async () => {
    await render();
    expect(directions()).toEqual([
      "North",
      "South",
      "West",
      "East",
      "NorthWest",
      "NorthEast",
      "SouthWest",
      "SouthEast",
    ]);
  });

  it("puts the corners after the edges, so they win the overlap", async () => {
    await render();
    // Corners overlap edges; paint order decides which takes the pointer.
    const corners = directions()
      .map((d, i) => ({ d, i }))
      .filter(
        ({ d }) =>
          d !== "North" && d !== "South" && d !== "West" && d !== "East",
      );
    expect(corners).toHaveLength(4);
    expect(Math.min(...corners.map((c) => c.i))).toBe(4);
  });

  it("drags the edge it belongs to", async () => {
    await render();
    press("SouthEast");
    expect(win.startResizeDragging).toHaveBeenCalledWith("SouthEast");
    press("North");
    expect(win.startResizeDragging).toHaveBeenLastCalledWith("North");
  });

  it("ignores anything but the left button", async () => {
    await render();
    press("East", 2);
    expect(win.startResizeDragging).not.toHaveBeenCalled();
  });

  it("shows nothing while the window is maximized", async () => {
    win.isMaximized.mockResolvedValue(true);
    await render();
    expect(grips()).toHaveLength(0);
  });

  it("hides and restores as the window is maximized and put back", async () => {
    await render();
    expect(grips()).toHaveLength(8);

    win.isMaximized.mockResolvedValue(true);
    await act(async () => onResized?.());
    expect(grips()).toHaveLength(0);

    win.isMaximized.mockResolvedValue(false);
    await act(async () => onResized?.());
    expect(grips()).toHaveLength(8);
  });

  it("drops its size listener when it goes away", async () => {
    await render();
    await act(async () => root.unmount());
    expect(unlisten).toHaveBeenCalled();
    root = createRoot(container);
  });
});
