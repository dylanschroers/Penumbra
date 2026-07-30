import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSession,
  SESSION_KEY,
  type SnapZone,
  saveSession,
} from "./session";

const ALLOWED = ["tasks", "lab", "weather"];

const win = (id: string, zone: SnapZone | null = "center", rect = {}) => ({
  id,
  zone,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  ...rect,
});

describe("shell session", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the open set and the windows", () => {
    const windows = [
      win("lab", "left"),
      win("tasks", null, { x: 40, y: 60, w: 500, h: 400 }),
    ];
    saveSession({ open: ["tasks", "lab"], windows });
    expect(loadSession(ALLOWED)).toEqual({ open: ["tasks", "lab"], windows });
  });

  it("preserves dock order", () => {
    saveSession({ open: ["weather", "tasks", "lab"], windows: [] });
    expect(loadSession(ALLOWED).open).toEqual(["weather", "tasks", "lab"]);
  });

  it("starts empty when nothing is stored", () => {
    expect(loadSession(ALLOWED)).toEqual({ open: [], windows: [] });
  });

  // The reason ids are validated rather than trusted: a stored id that is no
  // longer in the registry would render a dock card for a module getModule
  // cannot resolve.
  it("drops modules the registry no longer offers", () => {
    saveSession({ open: ["tasks", "retired-module"], windows: [] });
    expect(loadSession(ALLOWED).open).toEqual(["tasks"]);
  });

  it("drops a window whose module was retired, rather than keeping it dangling", () => {
    saveSession({
      open: ["retired-module"],
      windows: [win("retired-module")],
    });
    expect(loadSession(ALLOWED)).toEqual({ open: [], windows: [] });
  });

  it("refuses a window for a module that isn't open", () => {
    saveSession({ open: ["tasks"], windows: [win("lab")] });
    expect(loadSession(ALLOWED)).toEqual({ open: ["tasks"], windows: [] });
  });

  it("re-centres a free window stored without a usable rect", () => {
    saveSession({
      open: ["tasks"],
      windows: [win("tasks", null, { w: 0, h: -3 })],
    });
    expect(loadSession(ALLOWED).windows).toEqual([win("tasks", "center")]);
  });

  it("reopens a legacy focused module as a centred window", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ open: ["tasks"], focused: "tasks" }),
    );
    expect(loadSession(ALLOWED).windows).toEqual([win("tasks", "center")]);
  });

  it("survives corrupt json", () => {
    localStorage.setItem(SESSION_KEY, "{not json");
    expect(loadSession(ALLOWED)).toEqual({ open: [], windows: [] });
  });

  it("survives a stored value of the wrong shape", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ open: "tasks" }));
    expect(loadSession(ALLOWED)).toEqual({ open: [], windows: [] });
  });

  it("ignores non-string entries in the open set", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ open: ["tasks", 7, null], windows: [] }),
    );
    expect(loadSession(ALLOWED).open).toEqual(["tasks"]);
  });
});
