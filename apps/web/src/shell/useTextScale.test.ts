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

// The pure half of the text zoom: clamping and key mapping. The effect that
// wires these to keydown and <html> is a thin shell over them — thin, but it
// runs from App's first effect with no error boundary above it, so the way it
// behaves when storage is unavailable is pinned below too.

/** Mount the hook on its own, the way App does. */
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
    // Already at the floor: another shrink is a no-op, not a value below MIN.
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
    // Back to 1×: the inline size is dropped rather than pinned at 100%, and
    // the stored value goes with it.
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

  // Storage *throws* where it is blocked (a locked-down webview, Safari private
  // browsing) rather than returning null. This runs from App's first effect and
  // nothing catches above it, so an unguarded read would blank the entire app
  // over a zoom preference — and the boot watchdog would reload twice into the
  // same wall before showing an error.
  it("still starts when localStorage is unavailable", () => {
    const blocked = () => {
      throw new Error("storage is blocked");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

    const unmount = mount();
    expect(document.documentElement.style.fontSize).toBe("");

    // And a zoom still works for the session, it just will not be remembered.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "+", ctrlKey: true }),
      );
    });
    expect(document.documentElement.style.fontSize).toBe("110%");
    unmount();
  });
});
