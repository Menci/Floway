// Getting a reader over HTTP.
//
// A live stream has no length known in advance, so nothing in the transport tells a reader
// whether the body it just finished was the whole thing. Worse, measured against both the
// Cloudflare edge and local workerd: a Worker response body built from a `ReadableStream`
// that calls `controller.error()` — or whose `pull` throws — arrives at the client as a
// *clean end*. `fetch()` reports `done: true` and `curl` exits 0, indistinguishable from a
// normal close. So deliberately aborting the body signals nothing, and any design relying on
// the reader noticing the truncation relies on something that does not happen.
//
// The transport therefore frames. Each chunk is preceded by its length as a big-endian
// uint32, and a length of zero terminates:
//
//     [uint32 len][len bytes] [uint32 len][len bytes] … [00 00 00 00]
//
// This is chunked transfer encoding's own design, chosen over a terminal marker inside the
// content because a marker is a reserved value, and the obligation never to emit it would
// land on whoever produces the content. A length prefix puts the signal beside the bytes
// instead of inside them, so the content stays opaque and nothing needs escaping. It also
// detects strictly more: a marker reveals only a missing tail, while a length prefix also
// catches a body that stops part-way through a frame.
//
// Four bytes rather than two, because a uint16 caps a frame at 65535 — one byte short of the
// 64 KiB segment size — and 4 bytes on a 64 KiB frame is 0.006%.
//
// Reading the finished artifact needs none of this: a stored object has a `Content-Length`,
// so truncation is caught by the HTTP stack. The framing exists precisely because the live
// case has no length to state. Both paths hand the same bytes to the same NDJSON parser.

import type { LogStream } from './log-stream.ts';

const LENGTH_PREFIX_BYTES = 4;

/** Serves a live read as a framed body. The terminating frame is emitted only where the read
 *  completed on its own; where it threw, the body simply stops, which is what the reader half
 *  detects. */
export const serveLogStream = (stream: LogStream, fromOffset: number, signal: AbortSignal): Response => {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream.read(fromOffset, signal)) {
          if (chunk.byteLength === 0) continue;
          const header = new Uint8Array(LENGTH_PREFIX_BYTES);
          new DataView(header.buffer).setUint32(0, chunk.byteLength, false);
          controller.enqueue(header);
          controller.enqueue(chunk);
        }
        controller.enqueue(new Uint8Array(LENGTH_PREFIX_BYTES));
      } catch {
        // Ending without the terminator is the whole signal. Erroring the controller would
        // reach the client as a clean end, which is the measurement this framing exists for.
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
};

/** Thrown where a framed body ended without its terminator, or part-way through a frame. */
export class LogStreamTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogStreamTruncatedError';
  }
}

/**
 * Reads a framed body back into the chunks it carried.
 *
 * Chunk boundaries here are the writer's, not the network's: a frame is reassembled from
 * however many pieces the body arrived in. What a consumer gets is what the stream yielded.
 */
export const readLogStream = async function* (response: Response): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw new LogStreamTruncatedError('log stream response carried no body');

  // One growing buffer with a read cursor, compacted only when the cursor has passed
  // everything held. Frames are up to a segment, so this settles at about one segment.
  let held = new Uint8Array(0);
  let cursor = 0;
  let terminated = false;
  // The length a header declared while its bytes are still arriving, so a body that stops
  // here can say how far into the frame it got rather than how much is in the buffer.
  let awaiting: number | null = null;

  const take = (count: number): Uint8Array | null => {
    if (held.byteLength - cursor < count) return null;
    const slice = held.subarray(cursor, cursor + count);
    cursor += count;
    return slice;
  };

  for await (const piece of iterate(response.body)) {
    const remaining = held.subarray(cursor);
    const next = new Uint8Array(remaining.byteLength + piece.byteLength);
    next.set(remaining);
    next.set(piece, remaining.byteLength);
    held = next;
    cursor = 0;

    while (!terminated) {
      if (awaiting === null) {
        const header = take(LENGTH_PREFIX_BYTES);
        if (header === null) break;
        const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, false);
        if (length === 0) {
          terminated = true;
          break;
        }
        awaiting = length;
      }
      const frame = take(awaiting);
      if (frame === null) break;
      awaiting = null;
      yield frame.slice();
    }
    if (terminated) break;
  }

  if (!terminated) {
    throw new LogStreamTruncatedError(
      awaiting === null
        ? 'log stream body ended without its terminating frame'
        : `log stream body ended ${held.byteLength - cursor} bytes into a ${awaiting}-byte frame`,
    );
  }
};

const iterate = (body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value !== undefined) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  },
});
