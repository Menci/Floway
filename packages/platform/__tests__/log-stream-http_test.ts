import { expect, test } from 'vitest';

import { LogStreamTruncatedError, readLogStream, serveLogStream } from '../src/log-stream-http.ts';
import type { LogStream } from '../src/log-stream.ts';
import { assertEquals } from '@floway-dev/test-utils';

// A stream whose read yields exactly what it was given, and optionally throws instead of
// finishing. Only `read` is exercised here — the framing is about how a read's outcome
// reaches a client, not about storage.
const streamOf = (chunks: readonly Uint8Array[], failAfter?: number): LogStream => ({
  append: () => Promise.reject(new Error('not used')),
  end: () => Promise.reject(new Error('not used')),
  read: () => ({
    async *[Symbol.asyncIterator]() {
      for (const [index, chunk] of chunks.entries()) {
        if (failAfter !== undefined && index === failAfter) throw new Error('interrupted');
        yield chunk;
      }
      if (failAfter !== undefined && failAfter >= chunks.length) throw new Error('interrupted');
    },
  }),
});

const collect = async (response: Response): Promise<Uint8Array[]> => {
  const out: Uint8Array[] = [];
  for await (const chunk of readLogStream(response)) out.push(chunk);
  return out;
};

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

test('a completed read round-trips its chunks', async () => {
  const chunks = [bytes(1, 2, 3), bytes(), bytes(4)];
  const response = serveLogStream(streamOf(chunks), 0, new AbortController().signal);

  // The empty chunk carries nothing and is not framed: a zero length is the terminator.
  assertEquals(await collect(response), [bytes(1, 2, 3), bytes(4)]);
});

test('an interrupted read ends the body without its terminator, and the reader says so', async () => {
  const response = serveLogStream(streamOf([bytes(1, 2, 3)], 1), 0, new AbortController().signal);

  // This is the case the framing exists for. `controller.error()` reaches a client as a clean
  // end, so the absence of the terminating frame is the only thing that can carry it.
  await expect(collect(response)).rejects.toThrow(LogStreamTruncatedError);
});

test('a body that stops part-way through a frame is caught too', async () => {
  // Four bytes of header declaring three, then two. A terminal marker inside the content
  // could not see this; a length prefix can.
  const partial = bytes(0, 0, 0, 3, 9, 9);
  const truncated = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(partial);
      controller.close();
    },
  }));

  await expect(collect(truncated)).rejects.toThrow(/ended 2 bytes into a 3-byte frame/);
});

test('frames are reassembled across arbitrary network boundaries', async () => {
  // One frame of three bytes plus the terminator, delivered one byte at a time — every
  // boundary lands inside a header or inside a frame.
  const framed = [0, 0, 0, 3, 7, 8, 9, 0, 0, 0, 0];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of framed) controller.enqueue(bytes(byte));
      controller.close();
    },
  });

  assertEquals(await collect(new Response(body)), [bytes(7, 8, 9)]);
});

test('a chunk boundary may split a UTF-8 sequence, and the reader keeps the halves apart', async () => {
  // The reason `read()` yields bytes and never strings. `é` is two bytes; a writer that
  // chunked between them must not have them silently repaired or merged.
  const text = new TextEncoder().encode('café');
  const response = serveLogStream(streamOf([text.subarray(0, 4), text.subarray(4)]), 0, new AbortController().signal);

  const received = await collect(response);
  assertEquals(received.map(chunk => chunk.byteLength), [4, 1]);

  const decoder = new TextDecoder();
  const decoded = received.map((chunk, index) => decoder.decode(chunk, { stream: index < received.length - 1 })).join('');
  assertEquals(decoded, 'café');
});

test('a response with no body is a truncation rather than an empty stream', async () => {
  await expect(collect(new Response(null))).rejects.toThrow(LogStreamTruncatedError);
});
