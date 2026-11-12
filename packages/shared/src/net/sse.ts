// Reads SSE over fetch rather than EventSource, which can't POST or send
// Authorization and doesn't exist on the server.

export interface SseFrame<T = unknown> {
  event: string;
  data: T;
}

export interface ReadSseOptions {
  /**
   * "throw" for an agent turn; "skip" for long-lived streams like training
   * progress, where one bad frame must not kill the run.
   */
  onParseError?: "throw" | "skip";
}

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
