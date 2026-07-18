import type { AgentStatus, Engine } from "./types";

// Which backend answers, when more than one could.
//
// Ghost has two: the embedded model (Tier 0, offline, always present) and a
// server-side one (Tier 1, stronger, sometimes present). Neither is
// unconditionally right — Tier 1 is better when reachable, Tier 0 is the
// fallback that keeps guidance working with no server at all. Rather than
// pinning the choice to an env var and getting it wrong whenever reality
// disagrees, probe and take the first backend that reports ready.

export interface EngineCandidate {
  name: string;
  engine: Engine;
}

/**
 * An Engine that picks among candidates by readiness, in preference order.
 *
 * Resolution is re-run on every status poll rather than cached, so a server
 * coming up or going down is picked up within one poll instead of needing a
 * reload. A turn, by contrast, resolves once at the start and stays with that
 * engine — switching backends mid-conversation would silently change which
 * store the tools touch.
 */
export class ResolvingEngine implements Engine {
  private current: EngineCandidate | undefined;

  constructor(private readonly candidates: EngineCandidate[]) {}

  /** The backend that last answered a status probe, for diagnostics. */
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
    // Resolve now if no probe has run yet (or the last one found nothing), so
    // the first message after startup doesn't have to wait for a poll.
    if (!this.current) await this.getStatus();
    const chosen = this.current ?? this.candidates[0];
    if (!chosen) throw new Error("no engine configured");
    yield* chosen.engine.runAgent(...args);
  }
}
