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

  // The same distinction targets.ts draws for a deliberately keyless Studio: a
  // stored empty value is a choice, not a missing one, so it must not silently
  // reinstate the default it was set to replace.
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

  // A user who has edited has no other way back to a default that may have
  // improved since they typed.
  it("resets to the default", () => {
    store.set("something");
    expect(store.clear()).toMatchObject({
      persona: AGENT_PERSONA_DEFAULT,
      source: "default",
    });
  });
});

// Forbidding the wrong answers by name measurably produced them: with "never
// claim to be made by Anthropic" in the prompt, Qwen3-1.7B introduced itself as
// "developed by the company Anthropic" — a word it had only seen there. A
// negation still puts the token in the context. The rule is stated positively
// instead, and nothing here may name a company or the app.
describe("AGENT_POLICY names nothing to latch onto", () => {
  it.each([
    "Penumbra",
    "Anthropic",
    "OpenAI",
  ])("does not mention %s", (word) => {
    expect(AGENT_POLICY).not.toContain(word);
  });

  // The positive form has to actually point somewhere, or a model with no
  // identity line appended has nothing to answer from.
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

  // The eval must test the prompt the app ships, not whatever was last typed:
  // lab_scores records the model and target behind a score but not the prompt,
  // so an editable one would make two runs incomparable with nothing saying why.
  it("pins AGENT_SYSTEM to the default, ignoring any override", () => {
    store.set("Begin every reply with BANANA.");
    expect(AGENT_SYSTEM).toBe(composeSystem());
    expect(AGENT_SYSTEM).not.toContain("BANANA");
    expect(AGENT_SYSTEM).toContain(AGENT_PERSONA_DEFAULT);
  });
});

// The reply cap. Stored beside the persona because it is the same kind of
// setting, but it is an integer with a range rather than free text, and the
// "unset" case is load-bearing: the two tiers want different defaults, so no
// override is the only value that lets each keep its own.
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
    // A cap that guards nothing is worse than none, so nothing is written.
    expect(store.current().maxTokens).toBeNull();
  });

  it("refuses a fraction of a token", () => {
    expect(store.setMaxTokens(512.5)).toBeNull();
  });

  it("clears back to the per-tier defaults", () => {
    store.setMaxTokens(1024);
    expect(store.setMaxTokens(null)?.maxTokens).toBeNull();
  });

  // The two are independent settings that share one form; saving a cap must not
  // disturb a persona somebody spent time on.
  it("leaves the persona alone", () => {
    store.set("Answer in one sentence.");
    store.setMaxTokens(1024);
    expect(store.current().persona).toBe("Answer in one sentence.");
  });
});

// One form saves both, so one call applies both. The route used to apply them
// in turn, which meant a refusal could arrive after half the edit had already
// been written — and a 400 that has changed something is a lie about the
// request.
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

  // The case that used to leak a half-written edit: the persona is fine, the cap
  // is not, and the persona was saved before the cap was checked.
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

  // And the mirror image, which was already safe by ordering alone. Pinned so it
  // stays safe if the order ever changes.
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
