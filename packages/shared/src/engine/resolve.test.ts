import { describe, expect, it, vi } from "vitest";
import { ResolvingEngine } from "./resolve";
import type { AgentEvent, AgentStatus, Engine } from "./types";

function stub(status: AgentStatus, answer = "from stub"): Engine {
  return {
    getStatus: vi.fn().mockResolvedValue(status),
    async *runAgent(): AsyncGenerator<AgentEvent> {
      yield { kind: "answer", text: answer };
    },
  };
}

const ready = (model: string) => ({ state: "ready", model }) as AgentStatus;
const stopped = { state: "stopped" } as AgentStatus;
const noModel = { state: "no_model" } as AgentStatus;

async function firstEvent(engine: Engine) {
  for await (const ev of engine.runAgent([{ role: "user", content: "x" }])) {
    return ev;
  }
}

describe("ResolvingEngine", () => {
  it("takes the first ready candidate in preference order", async () => {
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(ready("big"), "remote") },
      { name: "local", engine: stub(ready("small"), "local") },
    ]);

    expect(await engine.getStatus()).toEqual(ready("big"));
    expect(engine.active).toBe("remote");
    expect(await firstEvent(engine)).toEqual({
      kind: "answer",
      text: "remote",
    });
  });

  // The whole point of the fallback: no server must still mean a working agent.
  it("falls back when the preferred candidate is absent", async () => {
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(stopped, "remote") },
      { name: "local", engine: stub(ready("small"), "local") },
    ]);

    expect(await engine.getStatus()).toEqual(ready("small"));
    expect(engine.active).toBe("local");
    expect(await firstEvent(engine)).toEqual({ kind: "answer", text: "local" });
  });

  it("reports no_model over stopped when nothing is ready", async () => {
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(stopped) },
      { name: "local", engine: stub(noModel) },
    ]);
    expect(await engine.getStatus()).toEqual(noModel);
    expect(engine.active).toBeUndefined();
  });

  it("reports stopped when every candidate is absent", async () => {
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(stopped) },
      { name: "local", engine: stub(stopped) },
    ]);
    expect(await engine.getStatus()).toEqual(stopped);
  });

  it("does not probe later candidates once one is ready", async () => {
    const local = stub(ready("small"));
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(ready("big")) },
      { name: "local", engine: local },
    ]);
    await engine.getStatus();
    expect(local.getStatus).not.toHaveBeenCalled();
  });

  // A backend arriving or leaving must be picked up without a reload.
  it("re-resolves on each probe as availability changes", async () => {
    const remote = stub(stopped, "remote");
    const engine = new ResolvingEngine([
      { name: "remote", engine: remote },
      { name: "local", engine: stub(ready("small"), "local") },
    ]);

    await engine.getStatus();
    expect(engine.active).toBe("local");

    (remote.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      ready("big"),
    );
    await engine.getStatus();
    expect(engine.active).toBe("remote");
  });

  it("resolves on demand when a turn starts before any probe", async () => {
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(stopped, "remote") },
      { name: "local", engine: stub(ready("small"), "local") },
    ]);
    expect(await firstEvent(engine)).toEqual({ kind: "answer", text: "local" });
  });

  // With nothing ready we still have to try something rather than hang; the
  // preferred candidate's own error is the most useful thing to surface.
  it("falls back to the first candidate when none report ready", async () => {
    const engine = new ResolvingEngine([
      { name: "remote", engine: stub(stopped, "remote") },
      { name: "local", engine: stub(stopped, "local") },
    ]);
    expect(await firstEvent(engine)).toEqual({
      kind: "answer",
      text: "remote",
    });
  });

  it("throws rather than hanging when configured with no candidates", async () => {
    const engine = new ResolvingEngine([]);
    await expect(firstEvent(engine)).rejects.toThrow("no engine configured");
  });
});
