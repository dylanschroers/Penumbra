import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyReply } from "fastify";

// Opening a Server-Sent Events stream without throwing away the headers Fastify
// already decided on.
//
// Both SSE routes bypass `reply.send` and write to the raw Node socket, because
// they emit events over a turn or a job rather than one body. The trap is that
// `reply.raw.writeHead` writes *its own* header set straight to the socket:
// anything a plugin queued on the Fastify reply — notably @fastify/cors's
// access-control-allow-origin — is never flushed. The route then answers 200
// with no CORS headers, the browser discards the response before a line of it
// reaches the client, and `fetch` rejects with a bare "Failed to fetch" that
// names neither the route nor the reason. Every non-streaming route on the same
// server keeps working, which is what makes it look like the stream itself is
// broken.
//
// So the queued headers are read back and merged in. Passing them through by
// name instead would mean restating the cors plugin's own logic (which origin it
// reflects, whether credentials are allowed) in two places, to drift the first
// time the policy changes.

/** SSE's own headers. The stream must not be buffered or cached anywhere. */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/**
 * Write a 200 and open `reply.raw` as an event stream, preserving every header
 * Fastify and its plugins have already set on the reply.
 *
 * Call once, before the first `send`. SSE's headers win over a queued header of
 * the same name: a plugin setting `Content-Type` must not turn the stream into
 * something the client will not read as one.
 */
export function openSseStream(reply: FastifyReply): void {
  // Fastify types a queued header as possibly `undefined`, which writeHead will
  // not take, so the unset ones are dropped rather than forwarded as holes.
  const queued: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) queued[name] = value;
  }
  reply.raw.writeHead(200, { ...queued, ...SSE_HEADERS });
}
