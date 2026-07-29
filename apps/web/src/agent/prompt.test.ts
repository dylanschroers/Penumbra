import { AGENT_PERSONA_DEFAULT, STORAGE_NAMESPACE } from "@penumbra/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { cachedPersona } from "./prompt";

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
