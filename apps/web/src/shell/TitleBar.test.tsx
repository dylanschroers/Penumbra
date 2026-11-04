import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";

// Custom controls on macOS would sit beside the traffic lights and bypass native
// full screen, and nothing would fail loudly.

const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock("./platform", () => ({
  get isMac() {
    return platform.isMac;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TitleBar", () => {
  it("is only a drag strip on macOS", () => {
    platform.isMac = true;
    act(() => root.render(<TitleBar />));
    const bar = container.querySelector("header");
    expect(bar?.getAttribute("data-tauri-drag-region")).toBe("true");
    expect(bar?.childElementCount).toBe(0);
  });

  it("carries the custom window controls elsewhere", () => {
    platform.isMac = false;
    act(() => root.render(<TitleBar />));
    expect(
      [...container.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Minimize window",
      "Maximize or restore window",
      "Close window",
    ]);
  });
});
