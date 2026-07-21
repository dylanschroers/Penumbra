import { describe, expect, it } from "vitest";
import { readSseFrames, type SseFrame } from "./sse";

/** Build a ReadableStream that emits the given strings as UTF-8 chunks, so a
 *  test can control exactly where the byte boundaries fall. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(
  gen: AsyncGenerator<SseFrame<T>>,
): Promise<SseFrame<T>[]> {
  const out: SseFrame<T>[] = [];
  for await (const frame of gen) out.push(frame);
  return out;
}

describe("readSseFrames", () => {
  it("decodes whole frames", async () => {
    const frames = await collect(
      readSseFrames(
        streamOf('event: agent\ndata: {"n":1}\n\nevent: done\ndata: {}\n\n'),
      ),
    );
    expect(frames).toEqual([
      { event: "agent", data: { n: 1 } },
      { event: "done", data: {} },
    ]);
  });

  it("reassembles a frame split across chunks", async () => {
    // The blank-line separator itself straddles the chunk boundary.
    const frames = await collect(
      readSseFrames(streamOf('event: agent\ndata: {"n"', ":1}\n", "\n")),
    );
    expect(frames).toEqual([{ event: "agent", data: { n: 1 } }]);
  });

  it("ignores a frame missing an event or data line", async () => {
    const frames = await collect(
      readSseFrames(streamOf(": comment only\n\ndata: {}\n\n")),
    );
    expect(frames).toEqual([]);
  });

  it('throws on malformed JSON by default (data: "not json")', async () => {
    await expect(
      collect(readSseFrames(streamOf("event: agent\ndata: not json\n\n"))),
    ).rejects.toThrow();
  });

  it('skips a malformed frame when onParseError is "skip"', async () => {
    const frames = await collect(
      readSseFrames(
        streamOf('event: bad\ndata: not json\n\nevent: ok\ndata: {"n":2}\n\n'),
        { onParseError: "skip" },
      ),
    );
    expect(frames).toEqual([{ event: "ok", data: { n: 2 } }]);
  });

  it("drops an unterminated trailing frame", async () => {
    // No closing blank line, so the last frame never completes.
    const frames = await collect(
      readSseFrames(
        streamOf("event: agent\ndata: {}\n\nevent: partial\ndata:"),
      ),
    );
    expect(frames).toEqual([{ event: "agent", data: {} }]);
  });
});
