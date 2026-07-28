import { beforeEach, describe, expect, it } from "vitest";
import { loadSession, SESSION_KEY, saveSession } from "./session";

const ALLOWED = ["tasks", "lab", "weather"];

describe("shell session", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the open set and the focused module", () => {
    saveSession({ open: ["tasks", "lab"], focused: "lab" });
    expect(loadSession(ALLOWED)).toEqual({
      open: ["tasks", "lab"],
      focused: "lab",
    });
  });

  it("preserves dock order", () => {
    saveSession({ open: ["weather", "tasks", "lab"], focused: null });
    expect(loadSession(ALLOWED).open).toEqual(["weather", "tasks", "lab"]);
  });

  it("starts empty when nothing is stored", () => {
    expect(loadSession(ALLOWED)).toEqual({ open: [], focused: null });
  });

  // The reason ids are validated rather than trusted: a stored id that is no
  // longer in the registry would render a dock card for a module getModule
  // cannot resolve.
  it("drops modules the registry no longer offers", () => {
    saveSession({ open: ["tasks", "retired-module"], focused: null });
    expect(loadSession(ALLOWED).open).toEqual(["tasks"]);
  });

  it("drops a focus whose module was retired, rather than keeping it dangling", () => {
    saveSession({ open: ["retired-module"], focused: "retired-module" });
    expect(loadSession(ALLOWED)).toEqual({ open: [], focused: null });
  });

  it("refuses a focus on a module that isn't open", () => {
    saveSession({ open: ["tasks"], focused: "lab" });
    expect(loadSession(ALLOWED)).toEqual({ open: ["tasks"], focused: null });
  });

  it("survives corrupt json", () => {
    localStorage.setItem(SESSION_KEY, "{not json");
    expect(loadSession(ALLOWED)).toEqual({ open: [], focused: null });
  });

  it("survives a stored value of the wrong shape", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ open: "tasks" }));
    expect(loadSession(ALLOWED)).toEqual({ open: [], focused: null });
  });

  it("ignores non-string entries in the open set", () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ open: ["tasks", 7, null], focused: null }),
    );
    expect(loadSession(ALLOWED).open).toEqual(["tasks"]);
  });
});
