// Reasoning-model output splitting, shared between server and clients. A model
// like Qwen3 wraps its chain-of-thought in `<think>…</think>` before the answer;
// the tags arrive split across many streamed deltas, so this keeps a running
// buffer and a tiny state machine, classifying text as reasoning vs answer and
// holding back only a partial-tag tail until the next delta resolves it.
//
// This lives in @ghost/shared because every inference engine (a server talking
// to a remote model, or a client running an embedded one) needs the exact same
// logic. See docs/AGENT_DESIGN.md → "The engine abstraction".

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** A piece of the reply, tagged as the model's reasoning or its actual answer. */
export interface ReplyChunk {
  kind: "reasoning" | "answer";
  text: string;
}

/** Longest suffix of `buffer` that is a proper prefix of `tag` (0 if none). */
function partialTagTail(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(buffer.slice(buffer.length - n))) return n;
  }
  return 0;
}

/**
 * Classify streamed text as reasoning vs answer, emitting chunks as soon as they
 * are unambiguous. `push` feeds a delta and returns any chunks it resolved;
 * `flush` drains the final buffer once the stream ends.
 */
export function createThinkSplitter() {
  let buffer = "";
  let inThink = false;

  function drain(final: boolean): ReplyChunk[] {
    const out: ReplyChunk[] = [];
    for (;;) {
      const tag = inThink ? THINK_CLOSE : THINK_OPEN;
      const kind: ReplyChunk["kind"] = inThink ? "reasoning" : "answer";
      const i = buffer.indexOf(tag);
      if (i !== -1) {
        if (i > 0) out.push({ kind, text: buffer.slice(0, i) });
        buffer = buffer.slice(i + tag.length);
        inThink = !inThink;
        continue;
      }
      // No full tag yet: emit everything except a tail that might still grow
      // into one (unless this is the final flush, where nothing more arrives).
      const hold = final ? 0 : partialTagTail(buffer, tag);
      const emit = buffer.slice(0, buffer.length - hold);
      if (emit) out.push({ kind, text: emit });
      buffer = buffer.slice(buffer.length - hold);
      break;
    }
    return out;
  }

  return {
    push: (text: string) => ((buffer += text), drain(false)),
    flush: () => drain(true),
  };
}
