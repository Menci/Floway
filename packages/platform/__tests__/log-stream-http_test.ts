import { expect, test } from 'vitest';

import { LogStreamTruncatedError, readLogStream, serveLogStream } from '../src/log-stream-http.ts';
import type { LogStream } from '../src/log-stream.ts';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const streamOf = (chunks: readonly Uint8Array[], failAt?: number): LogStream => ({
  append: async () => {},
  end: async () => {},
  read: (_fromOffset, signal) => ({
    async *[Symbol.asyncIterator]() {
      for (const [index, chunk] of chunks.entries()) {
        signal.throwIfAborted();
        if (index === failAt) throw new Error('read interrupted');
        yield chunk;
      }
      if (failAt === chunks.length) throw new Error('read interrupted');
    },
  }),
});

const collect = async (response: Response): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of readLogStream(response)) chunks.push(chunk);
  return chunks;
};

const responseFromPieces = (pieces: readonly Uint8Array[]): Response => new Response(new ReadableStream({
  start(controller) {
    for (const piece of pieces) controller.enqueue(piece);
    controller.close();
  },
}));

test('a network interruption is reported as truncated with its original cause and the reader unlocked', async () => {
  const cause = new TypeError('connection reset');
  const body = new ReadableStream({ start(controller) { controller.error(cause); } });
  await expect(collect(new Response(body))).rejects.toMatchObject({ name: 'LogStreamTruncatedError', cause });
  expect(body.locked).toBe(false);
});

test('a completed read round-trips non-empty frames and ignores empty chunks', async () => {
  const response = serveLogStream(streamOf([bytes(1, 2, 3), bytes(), bytes(4)]), 0, new AbortController().signal);
  expect(await collect(response)).toEqual([bytes(1, 2, 3), bytes(4)]);
});

test('serveLogStream pulls only when the HTTP reader requests more body', async () => {
  let pulled = 0;
  const response = serveLogStream({
    append: async () => {},
    end: async () => {},
    read: () => ({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 100; index++) {
          pulled++;
          yield bytes(index);
        }
      },
    }),
  }, 0, new AbortController().signal);

  await Promise.resolve();
  expect(pulled).toBe(0);
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(bytes(0, 0, 0, 1));
  expect(pulled).toBe(1);
  expect((await reader.read()).value).toEqual(bytes(0));
  expect(pulled).toBe(1);
  await reader.cancel();
});

test('aborting the request closes the source iterator after it observes cancellation', async () => {
  let returned: unknown;
  const controller = new AbortController();
  const response = serveLogStream({
    append: async () => {},
    end: async () => {},
    read: (_fromOffset, signal) => ({
      async *[Symbol.asyncIterator]() {
        try {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            if (signal.aborted) reject(signal.reason);
          });
        } finally {
          returned = 'returned';
        }
      },
    }),
  }, 0, controller.signal);

  const reader = response.body!.getReader();
  const pending = reader.read();
  const reason = new Error('client disconnected');
  controller.abort(reason);
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(returned).toBe('returned');
  await reader.cancel();
});

test('an interrupted read closes without the EOF frame and is reported as truncated', async () => {
  const response = serveLogStream(streamOf([bytes(1, 2, 3)], 1), 0, new AbortController().signal);
  await expect(collect(response)).rejects.toBeInstanceOf(LogStreamTruncatedError);
});

test('a byte-at-a-time 64 KiB frame plus EOF is reassembled exactly', async () => {
  const payload = new Uint8Array(64 * 1024);
  for (let index = 0; index < payload.byteLength; index++) payload[index] = index % 251;
  const framed = new Uint8Array(4 + payload.byteLength + 4);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, false);
  framed.set(payload, 4);

  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < framed.byteLength; offset++) pieces.push(framed.subarray(offset, offset + 1));
  const [received] = await collect(responseFromPieces(pieces));
  expect(received).toEqual(payload);
});

test('frame pieces may split both headers and payloads arbitrarily', async () => {
  const encoder = new TextEncoder();
  const first = encoder.encode('first');
  const second = encoder.encode('second');
  const framed = new Uint8Array(12 + first.byteLength + second.byteLength);
  const view = new DataView(framed.buffer);
  view.setUint32(0, first.byteLength, false);
  framed.set(first, 4);
  view.setUint32(4 + first.byteLength, second.byteLength, false);
  framed.set(second, 8 + first.byteLength);

  const pieces = [framed.subarray(0, 2), framed.subarray(2, 7), framed.subarray(7, 14), framed.subarray(14)];
  expect(await collect(responseFromPieces(pieces))).toEqual([first, second]);
});

test('a body ending during a length header is truncated', async () => {
  await expect(collect(responseFromPieces([bytes(0, 0), bytes(0)]))).rejects.toThrow(/3 bytes into a 4-byte frame header/);
});

test('a body ending during a frame is truncated', async () => {
  await expect(collect(responseFromPieces([bytes(0, 0, 0, 3, 9, 9)]))).rejects.toThrow(/2 bytes into a 3-byte frame/);
});

test('a response without a body is truncated', async () => {
  await expect(collect(new Response(null))).rejects.toThrow(/carried no body/);
});

test('aborting serveLogStream closes the response and cancels the source read', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = serveLogStream({
    append: async () => {},
    end: async () => {},
    read: (_fromOffset, signal) => ({
      async *[Symbol.asyncIterator]() {
        try {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            if (signal.aborted) reject(signal.reason);
          });
        } finally {
          cancelled = true;
        }
      },
    }),
  }, 0, controller.signal);

  const reader = response.body!.getReader();
  const pending = reader.read();
  controller.abort(new Error('client disconnected'));
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(true);
  await reader.cancel();
});
