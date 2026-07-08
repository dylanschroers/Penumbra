import type { AgentStatus, ChatMessage } from "../validation/agent";
import type { ReplyChunk } from "./think";

// The seam every model backend hides behind. The UI drives an InferenceEngine
// without knowing whether the reply came from a local embedded model, a
// self-hosted server, or an opt-in cloud provider — they all yield the same
// classified ReplyChunk stream. See docs/AGENT_DESIGN.md → "The engine
// abstraction" and "The provider-neutral seam".
export interface InferenceEngine {
  /** Backend readiness for the status pill. Never throws; reports a state. */
  getStatus(): Promise<AgentStatus>;

  /**
   * Stream one assistant turn as classified chunks (reasoning vs answer). The
   * optional signal aborts the turn; an aborted stream rejects rather than
   * completing, so callers can distinguish cancel from error.
   */
  streamReply(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<ReplyChunk>;
}
