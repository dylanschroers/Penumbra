import {
  AGENT_PERSONA_DEFAULT,
  AGENT_PERSONA_MAX,
  AGENT_POLICY,
  STORAGE_NAMESPACE,
} from "@penumbra/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { cachedPersona, localPrompt } from "./prompt";

// Tier 0's promise is "offline, always available", so the persona it runs with
// has to be readable synchronously and without a server. The mirror in
// localStorage is what makes that true; these cover what it answers when the
// server has never been reached, and the empty-vs-absent distinction.

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

  // Absent means "never fetched"; empty means a persona deliberately cleared to
  // mean "no style guidance". Collapsing the two would quietly reinstate the
  // default the user removed.
  it("keeps a deliberately empty persona empty", () => {
    localStorage.setItem(KEY, "");
    expect(cachedPersona()).toBe("");
  });

  it("adopts a value left under the pre-namespace key", () => {
    localStorage.setItem("penumbra.agent.persona", "legacy");
    expect(cachedPersona()).toBe("legacy");
  });
});

// What the panel renders when no server has answered. The point is that it is
// the real prompt rather than a placeholder: the same persona the engine reads,
// and the policy constant the turn is actually composed from.
describe("localPrompt", () => {
  it("assembles the whole prompt with no server", () => {
    expect(localPrompt()).toEqual({
      persona: AGENT_PERSONA_DEFAULT,
      fallback: AGENT_PERSONA_DEFAULT,
      policy: AGENT_POLICY,
      source: "default",
      maxLength: AGENT_PERSONA_MAX,
    });
  });

  it("reports the mirrored persona as an override", () => {
    localStorage.setItem(KEY, "Answer in one sentence.");
    expect(localPrompt()).toMatchObject({
      persona: "Answer in one sentence.",
      source: "settings",
    });
  });

  // Presence of the key decides, not equality with the default: a user who set
  // the persona to the default text still chose it, and "Reset to default" is
  // enabled off `source`.
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
