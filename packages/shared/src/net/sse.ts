// Server-Sent Events frame decoder, shared by every consumer of an SSE stream:
// the web RemoteEngine (a Tier-1 agent turn) and the server's StudioClient
// (training progress). Both read the stream by hand over fetch + a
// ReadableStream reader rather than EventSource, which cannot send a POST body
// or an Authorization header and does not exist on the server at all.
//
// The one subtlety is chunk boundaries: a frame can arrive split across reads,
// so bytes are buffered and only cut on each blank-line separator, with the
// leftover tail carried forward.

export interface SseFrame<T = unknown> {
  event: string;
  /** The decoded `data:` payload. JSON.parse returns `any`; callers that know
   *  the shape pass a type argument, mirroring the cast each did inline. */
  data: T;
}

export interface ReadSseOptions {
  /**
   * What to do when a frame's `data:` is not valid JSON.
   *  - "throw" (default): let it propagate and end the stream — right when a
   *    bad frame means the turn is broken (an agent turn).
   *  - "skip": drop the frame and keep reading — right for a long-lived stream
   *    where one garbled frame must not kill the run (training progress).
   */
  onParseError?: "throw" | "skip";
}

/** Extract one `{ event, data }` from a raw frame, or undefined when the frame
 *  lacks either line. Both fields must be non-empty, matching the original
 *  `if (event && raw)` guard both call sites used. */
function parseFrame<T>(
  chunk: string,
  onParseError: "throw" | "skip",
): SseFrame<T> | undefined {
  const event = /^event: (.*)$/m.exec(chunk)?.[1];
  const raw = /^data: (.*)$/m.exec(chunk)?.[1];
  if (!event || !raw) return undefined;
  try {
    return { event, data: JSON.parse(raw) as T };
  } catch (err) {
    if (onParseError === "throw") throw err;
    return undefined;
  }
}

/** Decode an SSE byte stream into frames, carrying partial tails forward. */
export async function* readSseFrames<T = unknown>(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseFrame<T>> {
  const onParseError = options.onParseError ?? "throw";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseFrame<T>(chunk, onParseError);
        if (frame) yield frame;
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
