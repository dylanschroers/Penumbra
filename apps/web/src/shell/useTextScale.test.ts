import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampScale,
  MAX_SCALE,
  MIN_SCALE,
  scaleForKey,
  useTextScale,
} from "./useTextScale";

// The effect runs from App's first effect with no error boundary, so its
// behaviour without storage is pinned too.

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const Probe = () => {
    useTextScale();
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
});

describe("text scale", () => {
  it("holds inside the range", () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(9)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });

  it("does not drift or run past the floor over repeated steps", () => {
    let s = 1;
    for (let i = 0; i < 3; i++) {
      const next = scaleForKey(s, "-");
      if (next === null) throw new Error("expected a scale");
      s = next;
    }
    expect(s).toBe(0.7);
    expect(scaleForKey(MIN_SCALE, "-")).toBe(MIN_SCALE);
  });

  it("maps the +/-/0 spellings and ignores anything else", () => {
    expect(scaleForKey(1, "=")).toBeCloseTo(1.1);
    expect(scaleForKey(1, "+")).toBeCloseTo(1.1);
    expect(scaleForKey(1, "-")).toBeCloseTo(0.9);
    expect(scaleForKey(1, "_")).toBeCloseTo(0.9);
    expect(scaleForKey(1.4, "0")).toBe(1);
    expect(scaleForKey(1, "a")).toBeNull();
  });

  it("restores a stored scale on mount and keeps a change", () => {
    localStorage.setItem("app.shell.text-scale.v1", "1.2");
    const unmount = mount();
    expect(document.documentElement.style.fontSize).toBe("120%");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "0", ctrlKey: true }),
      );
    });
    expect(document.documentElement.style.fontSize).toBe("");
    expect(localStorage.getItem("app.shell.text-scale.v1")).toBeNull();
    unmount();
  });

  it("carries a zoom over from the pre-namespace key", () => {
    localStorage.setItem("penumbra:text-scale", "1.3");
    const unmount = mount();

    expect(document.documentElement.style.fontSize).toBe("130%");
    expect(localStorage.getItem("app.shell.text-scale.v1")).toBe("1.3");
    expect(localStorage.getItem("penumbra:text-scale")).toBeNull();
    unmount();
  });

  // Blocked storage throws rather than returning null; unguarded, this would
  // blank the app.
  it("still starts when localStorage is unavailable", () => {
    const blocked = () => {
      throw new Error("storage is blocked");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

    const unmount = mount();
    expect(document.documentElement.style.fontSize).toBe("");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "+", ctrlKey: true }),
      );
    });
    expect(document.documentElement.style.fontSize).toBe("110%");
    unmount();
  });
});
