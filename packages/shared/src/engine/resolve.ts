import type { AgentStatus, Engine } from "./types";

export interface EngineCandidate {
  name: string;
  engine: Engine;
}

/**
 * Picks the first candidate that reports ready. Re-resolved on every status
 * poll, but a turn stays on the engine it started with, since switching
 * mid-conversation would change which store the tools touch.
 */
export class ResolvingEngine implements Engine {
  private current: EngineCandidate | undefined;

  constructor(private readonly candidates: EngineCandidate[]) {}

  get active(): string | undefined {
    return this.current?.name;
  }

  async getStatus(): Promise<AgentStatus> {
    let fallback: AgentStatus = { state: "stopped" };

    for (const candidate of this.candidates) {
      const status = await candidate.engine.getStatus();
      if (status.state === "ready") {
        this.current = candidate;
        return status;
      }
      // A backend that is up but has no model loaded is more informative than
      // one that is simply absent, so it outranks "stopped" in the report.
      if (status.state === "no_model" && fallback.state === "stopped") {
        fallback = status;
      }
    }

    this.current = undefined;
    return fallback;
  }

  async *runAgent(...args: Parameters<Engine["runAgent"]>) {
    if (!this.current) await this.getStatus();
    const chosen = this.current ?? this.candidates[0];
    if (!chosen) throw new Error("no engine configured");
    yield* chosen.engine.runAgent(...args);
  }
}
