import type { AgentStatus } from "@penumbra/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A conversation can change model underneath itself — the compute target is
// reassigned, or a Colab session ends and the role falls back to the local
// Studio. The transcript would then hold answers from two models with nothing
// separating them, which is invisible until someone tries to explain a sudden
// change in behaviour. That marker is what these tests pin.

let status: AgentStatus = { state: "ready", model: "m" };

vi.mock("../../engine", () => ({
  engine: {
    getStatus: async () => status,
    runAgent: async function* () {
      yield { kind: "answer", text: "hi" };
    },
  },
  getProvider: () => "server",
  setProvider: () => {},
  PROVIDERS: [],
}));

const { useAgent } = await import("./useAgent");

let container: HTMLDivElement;
let root: Root;
/** The hook's latest return value, captured from a throwaway host component. */
let latest: ReturnType<typeof useAgent>;

function Probe() {
  latest = useAgent();
  return null;
}

async function mount() {
  await act(async () => {
    root.render(<Probe />);
  });
}

/** Change what the backend reports, then let the poll pick it up. */
async function reportStatus(next: AgentStatus) {
  status = next;
  await act(async () => {
    vi.advanceTimersByTime(5000);
    // Let the awaited getStatus resolve inside act.
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  status = {
    state: "ready",
    model: "m",
    target: { id: "local", label: "Local Studio" },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const notices = () => latest.messages.filter((m) => m.notice);

describe("compute target changes", () => {
  it("says nothing while the target holds steady", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });
    await reportStatus({
      state: "ready",
      model: "m",
      target: { id: "local", label: "Local Studio" },
    });
    expect(notices()).toHaveLength(0);
  });

  it("marks the thread when answers start coming from elsewhere", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({
      state: "ready",
      model: "m",
      target: { id: "colab", label: "Colab" },
    });

    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.content).toContain("Colab");
  });

  // The marker is about a boundary between turns. An empty thread has no
  // boundary, and opening the app to a note about a switch nobody saw happen
  // would be noise.
  it("stays quiet when the thread is empty", async () => {
    await mount();
    await reportStatus({
      state: "ready",
      target: { id: "colab", label: "Colab" },
    });
    expect(notices()).toHaveLength(0);
  });

  it("marks each change once, not on every poll", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    const colab: AgentStatus = {
      state: "ready",
      target: { id: "colab", label: "Colab" },
    };
    await reportStatus(colab);
    await reportStatus(colab);
    await reportStatus(colab);

    expect(notices()).toHaveLength(1);
  });

  // The fallback case this exists for: Colab's config dies with the server
  // process, so the role silently resolves back to local with nobody touching
  // anything.
  it("marks a fallback the user never asked for", async () => {
    status = {
      state: "ready",
      target: { id: "colab", label: "Colab" },
    };
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({
      state: "ready",
      target: { id: "local", label: "Local Studio" },
    });

    expect(notices()[0]?.content).toContain("Local Studio");
  });
});

// One target serves one model at a time, and swapping it in Studio never
// touches the target id. Watching the target alone therefore stayed silent for
// the commonest change of all: the same machine now running different weights.
describe("model changes on one target", () => {
  const local = { id: "local", label: "Local Studio" };

  it("marks the thread when the model changes underneath it", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({ state: "ready", model: "qwen3-4b", target: local });

    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.content).toContain("qwen3-4b");
  });

  it("says nothing while the same model keeps answering", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });
    await reportStatus({ state: "ready", model: "m", target: local });
    await reportStatus({ state: "ready", model: "m", target: local });
    expect(notices()).toHaveLength(0);
  });

  // A restart drops the model to unknown and brings the same one back. The pill
  // already reports that; a notice per blip would bury the real changes.
  it("does not mark a backend blip as a model change", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({ state: "no_model", target: local });
    await reportStatus({ state: "stopped" });
    await reportStatus({ state: "ready", model: "m", target: local });

    expect(notices()).toHaveLength(0);
  });

  it("names both when the target and the model move together", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({
      state: "ready",
      model: "llama-3.2-1b",
      target: { id: "colab", label: "Colab" },
    });

    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.content).toContain("Colab");
    expect(notices()[0]?.content).toContain("llama-3.2-1b");
  });
});

// A marker separates two stretches of conversation. Switching provider and back
// leaves none between them, so the run of hops is one boundary at most — and if
// the thread ends up where it started, none at all. Polling the difference
// instead stacked a marker per hop around no conversation.
describe("a run of switches", () => {
  const local = { id: "local", label: "Local Studio" };
  const colab = { id: "colab", label: "Colab" };

  it("collapses consecutive hops into a single marker", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({ state: "ready", model: "a", target: colab });
    await reportStatus({ state: "ready", model: "b", target: local });
    await reportStatus({ state: "ready", model: "c", target: colab });

    expect(notices()).toHaveLength(1);
    // The one that survives describes where the thread actually ended up.
    expect(notices()[0]?.content).toContain("Colab");
    expect(notices()[0]?.content).toContain("c");
  });

  it("takes the marker back down on returning to where it started", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });

    await reportStatus({ state: "ready", model: "other", target: colab });
    expect(notices()).toHaveLength(1);

    await reportStatus({ state: "ready", model: "m", target: local });
    expect(notices()).toHaveLength(0);
  });

  // The boundary is relative to the last turn, so a second turn re-anchors it:
  // there is now conversation on both sides of the earlier change.
  it("keeps a marker that has conversation after it", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });
    await reportStatus({ state: "ready", model: "other", target: colab });
    await act(async () => {
      await latest.send("second");
    });
    await reportStatus({ state: "ready", model: "m", target: local });

    expect(notices()).toHaveLength(2);
  });
});

describe("clear", () => {
  // The transcript is the model's context: a wrong answer about its own
  // identity is replayed into every later turn and copied forward, so
  // discarding the thread is the only way out.
  it("empties the thread", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });
    expect(latest.messages.length).toBeGreaterThan(0);

    await act(async () => latest.clear());
    expect(latest.messages).toEqual([]);
  });

  it("leaves no boundary for a later change to mark", async () => {
    await mount();
    await act(async () => {
      await latest.send("hello");
    });
    await act(async () => latest.clear());

    await reportStatus({
      state: "ready",
      model: "different",
      target: { id: "colab", label: "Colab" },
    });
    expect(notices()).toHaveLength(0);
  });
});

describe("history sent to the model", () => {
  // A notice is the shell talking about the conversation. Replaying one would
  // present it as something the assistant said.
  it("leaves notices out", async () => {
    await mount();
    await act(async () => {
      await latest.send("first");
    });
    await reportStatus({
      state: "ready",
      target: { id: "colab", label: "Colab" },
    });
    expect(notices()).toHaveLength(1);

    await act(async () => {
      await latest.send("second");
    });

    // Every message the hook still holds that is *not* a notice is a real turn;
    // the notice never became one.
    expect(latest.messages.filter((m) => m.notice)).toHaveLength(1);
    expect(
      latest.messages.filter((m) => !m.notice).map((m) => m.content),
    ).not.toContain(notices()[0]?.content);
  });
});
