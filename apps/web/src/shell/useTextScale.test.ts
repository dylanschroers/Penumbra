import { describe, expect, it } from "vitest";
import { clampScale, MAX_SCALE, MIN_SCALE, scaleForKey } from "./useTextScale";

// The pure half of the text zoom: clamping and key mapping. The effect that
// wires these to keydown and <html> is a thin shell over them.

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
});
