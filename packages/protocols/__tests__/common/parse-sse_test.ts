import { test } from 'vitest';

import { parseSSEStream } from '../../src/common/parse-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
};

const waitForMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const cancelStateWithin = async (promise: Promise<void>, timeoutMs: number): Promise<'canceled' | 'pending'> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'canceled' as const),
      new Promise<'pending'>(resolve => {
        timeoutId = setTimeout(() => resolve('pending'), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

const collect = async (text: string) => {
  const frames = [];
  for await (const frame of parseSSEStream(new Response(text).body!)) {
    frames.push(frame);
  }
  return frames;
};

test('parseSSEStream flushes a final data line without a trailing newline', async () => {
  assertEquals(await collect('event: message_delta\ndata: not json'), [
    {
      type: 'sse',
      event: 'message_delta',
      data: 'not json',
    },
  ]);
});

test('parseSSEStream cancels a pending reader when its signal aborts', async () => {
  const upstreamCanceled = deferred<void>();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const downstreamAbortController = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
    },
    cancel() {
      upstreamCanceled.resolve();
    },
  });
  const iterator = parseSSEStream(body, {
    signal: downstreamAbortController.signal,
  });
  const pendingNext = iterator.next();

  try {
    await waitForMicrotasks();
    downstreamAbortController.abort();

    const cancelState = await cancelStateWithin(upstreamCanceled.promise, 20);

    assertEquals(cancelState, 'canceled');
    assertEquals(await pendingNext, { done: true, value: undefined });
  } finally {
    try {
      upstreamController.close();
    } catch {
      // The stream is already canceled in the passing path.
    }
    await iterator.return(undefined).catch(() => {});
  }
});

test('parseSSEStream keeps a pretty-printed bare JSON body as one raw frame', async () => {
  // Google's error bodies are indented across lines, and continuation lines
  // such as `  "code": 503,` would otherwise parse as unknown fields.
  const chunk = '{"candidates":[{"index":0}]}';
  const error = '{\n  "error": {\n    "code": 503,\n    "message": "overloaded",\n    "status": "UNAVAILABLE"\n  }\n}';
  for (const newline of ['\n', '\r\n']) {
    const frames: { kind: string; data: string }[] = [];
    const body = `data: ${chunk}${newline}${newline}${error.replaceAll('\n', newline)}${newline}`;
    for await (const frame of parseSSEStream(new Response(body).body!)) {
      frames.push({ kind: frame.type, data: frame.data });
    }
    assertEquals(frames, [
      { kind: 'sse', data: chunk },
      { kind: 'sse-raw', data: error },
    ]);
  }
});
