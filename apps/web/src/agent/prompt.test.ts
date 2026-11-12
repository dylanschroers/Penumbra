import {
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { cachedPersona, localPrompt } from "./prompt";

// Tier 0 must read the persona synchronously and offline, via the
// localStorage mirror.

const KEY = `${STORAGE_NAMESPACE}.agent.persona.v1`;

beforeEach(() => localStorage.clear());

describe("cachedPersona", () => {
  it("falls back to the shipped default before any fetch", () => {
    expect(cachedPersona()).toBe(AGENT_PERSONA_DEFAULT);
  });

  it("uses the mirrored persona once one is stored", () => {
    localStorage.setItem(KEY, "Answer in one sentence.");
    expect(cachedPersona()).toBe("Answer in one sentence.");
  });

  // Absent means never fetched; empty means deliberately cleared.
  it("keeps a deliberately empty persona empty", () => {
    localStorage.setItem(KEY, "");
    expect(cachedPersona()).toBe("");
  });

  it("adopts a value left under the pre-namespace key", () => {
    localStorage.setItem("penumbra.agent.persona", "legacy");
    expect(cachedPersona()).toBe("legacy");
  });
});

describe("localPrompt", () => {
  it("assembles the whole prompt with no server", () => {
    expect(localPrompt()).toEqual({
      persona: AGENT_PERSONA_DEFAULT,
      fallback: AGENT_PERSONA_DEFAULT,
      policy: AGENT_POLICY,
      source: "default",
      maxLength: AGENT_PERSONA_MAX,
      maxTokens: null,
    });
  });

  it("reports the mirrored persona as an override", () => {
    localStorage.setItem(KEY, "Answer in one sentence.");
    expect(localPrompt()).toMatchObject({
      persona: "Answer in one sentence.",
      source: "settings",
    });
  });

  // Key presence decides, not equality with the default.
  it("counts a persona set to the default text as an override", () => {
    localStorage.setItem(KEY, AGENT_PERSONA_DEFAULT);
    expect(localPrompt().source).toBe("settings");
  });

  it("agrees with cachedPersona on a deliberately empty persona", () => {
    localStorage.setItem(KEY, "");
    expect(localPrompt()).toMatchObject({ persona: "", source: "settings" });
    expect(cachedPersona()).toBe("");
  });
});
