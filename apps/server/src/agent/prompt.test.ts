import {
  AGENT_MAX_TOKENS_MAX,
  AGENT_MAX_TOKENS_MIN,
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
  AGENT_SYSTEM,
  composeSystem,
} from "@penumbra/shared";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createPromptStore, type PromptStore } from "./prompt";

let store: PromptStore;
beforeEach(() => {
  store = createPromptStore(new Database(":memory:"));
});

describe("createPromptStore", () => {
  it("starts on the shipped default", () => {
    const state = store.current();
    expect(state.persona).toBe(AGENT_PERSONA_DEFAULT);
    expect(state.source).toBe("default");
    expect(state.policy).toBe(AGENT_POLICY);
  });

  it("remembers a persona and reports it as an override", () => {
    store.set("Answer in one sentence.");
    expect(store.current()).toMatchObject({
      persona: "Answer in one sentence.",
      source: "settings",
    });
  });

  it("survives a new store over the same database", () => {
    const db = new Database(":memory:");
    createPromptStore(db).set("Terse.");
    expect(createPromptStore(db).current().persona).toBe("Terse.");
  });

  // A stored empty persona is a choice, not a missing value.
  it("treats an empty persona as a deliberate choice", () => {
    store.set("");
    expect(store.current()).toMatchObject({ persona: "", source: "settings" });
    expect(composeSystem("")).toBe(AGENT_POLICY);
  });

  it("refuses a persona past the cap and keeps the old one", () => {
    store.set("kept");
    expect(store.set("x".repeat(AGENT_PERSONA_MAX + 1))).toBeNull();
    expect(store.current().persona).toBe("kept");
  });

  it("accepts one exactly at the cap", () => {
    const persona = "x".repeat(AGENT_PERSONA_MAX);
    expect(store.set(persona)).not.toBeNull();
    expect(store.current().persona).toBe(persona);
  });

  it("resets to the default", () => {
    store.set("something");
    expect(store.clear()).toMatchObject({
      persona: AGENT_PERSONA_DEFAULT,
      source: "default",
    });
  });
});

// Naming what not to say makes a small model say it, so no company or app
// name may appear.
describe("AGENT_POLICY names nothing to latch onto", () => {
  it.each([
    "Penumbra",
    "Anthropic",
    "OpenAI",
  ])("does not mention %s", (word) => {
    expect(AGENT_POLICY).not.toContain(word);
  });

  it("directs the answer at the appended identity, with a fallback", () => {
    expect(AGENT_POLICY).toContain("stated at the end of these instructions");
    expect(AGENT_POLICY).toContain("do not know which model you are");
  });
});

describe("composeSystem", () => {
  it("leads with the policy so a persona cannot appear to precede it", () => {
    expect(composeSystem("Be terse.").startsWith(AGENT_POLICY)).toBe(true);
    expect(composeSystem("Be terse.")).toContain("Be terse.");
  });

  it("pins AGENT_SYSTEM to the default, ignoring any override", () => {
    store.set("Begin every reply with BANANA.");
    expect(AGENT_SYSTEM).toBe(composeSystem());
    expect(AGENT_SYSTEM).not.toContain("BANANA");
    expect(AGENT_SYSTEM).toContain(AGENT_PERSONA_DEFAULT);
  });
});

// Null (unset) is load-bearing: the two tiers want different defaults.
describe("reply-length cap", () => {
  it("is unset by default, so each tier keeps its own", () => {
    expect(store.current().maxTokens).toBeNull();
  });

  it("stores a value in range and reads it back", () => {
    expect(store.setMaxTokens(1024)?.maxTokens).toBe(1024);
    expect(store.current().maxTokens).toBe(1024);
  });

  it("refuses a value outside the range", () => {
    expect(store.setMaxTokens(AGENT_MAX_TOKENS_MAX + 1)).toBeNull();
    expect(store.setMaxTokens(AGENT_MAX_TOKENS_MIN - 1)).toBeNull();
    expect(store.current().maxTokens).toBeNull();
  });

  it("refuses a fraction of a token", () => {
    expect(store.setMaxTokens(512.5)).toBeNull();
  });

  it("clears back to the per-tier defaults", () => {
    store.setMaxTokens(1024);
    expect(store.setMaxTokens(null)?.maxTokens).toBeNull();
  });

  it("leaves the persona alone", () => {
    store.set("Answer in one sentence.");
    store.setMaxTokens(1024);
    expect(store.current().persona).toBe("Answer in one sentence.");
  });
});

// A refused update must change nothing.
describe("update applies a patch or none of it", () => {
  it("writes both fields together", () => {
    const result = store.update({ persona: "Terse.", maxTokens: 1024 });
    expect(result).toMatchObject({
      ok: true,
      state: { persona: "Terse.", maxTokens: 1024 },
    });
  });

  it("leaves an absent field as it was", () => {
    store.update({ persona: "Terse.", maxTokens: 1024 });
    store.update({ maxTokens: 2048 });
    expect(store.current()).toMatchObject({
      persona: "Terse.",
      maxTokens: 2048,
    });
  });

  it("clears the cap on an explicit null without touching the persona", () => {
    store.update({ persona: "Terse.", maxTokens: 1024 });
    store.update({ maxTokens: null });
    expect(store.current()).toMatchObject({
      persona: "Terse.",
      maxTokens: null,
    });
  });

  it("writes no persona when the cap is out of range", () => {
    store.update({ persona: "kept", maxTokens: 1024 });
    expect(
      store.update({
        persona: "should not land",
        maxTokens: AGENT_MAX_TOKENS_MAX + 1,
      }),
    ).toEqual({ ok: false, error: "out_of_range" });
    expect(store.current()).toMatchObject({
      persona: "kept",
      maxTokens: 1024,
    });
  });

  it("writes no cap when the persona is too long", () => {
    store.update({ persona: "kept", maxTokens: 1024 });
    expect(
      store.update({
        persona: "x".repeat(AGENT_PERSONA_MAX + 1),
        maxTokens: 2048,
      }),
    ).toEqual({ ok: false, error: "too_long" });
    expect(store.current()).toMatchObject({
      persona: "kept",
      maxTokens: 1024,
    });
  });
});
