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

test('parseSSEStream accepts fields without the optional space after the colon', async () => {
  assertEquals(await collect([
    'event:message_start',
    'data:{"type":"message_start"}',
    '',
    'event:message_stop',
    'data:{"type":"message_stop"}',
    '',
  ].join('\n')), [
    {
      type: 'sse',
      event: 'message_start',
      data: '{"type":"message_start"}',
    },
    {
      type: 'sse',
      event: 'message_stop',
      data: '{"type":"message_stop"}',
    },
  ]);
});

test('parseSSEStream joins data fields and resets event state at blank-line boundaries', async () => {
  assertEquals(await collect([
    ': ignored comment',
    'event:update',
    'data:first',
    'data:  second',
    'data:third ',
    '',
    'event:orphaned',
    '',
    'data:tail',
    '',
  ].join('\n')), [
    {
      type: 'sse',
      event: 'update',
      data: 'first\n second\nthird ',
    },
    {
      type: 'sse',
      event: undefined,
      data: 'tail',
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

test('parseSSEStream surfaces a bare JSON object line instead of dropping it', async () => {
  // `patches/eventsource-parser@3.1.0.patch`: a line that opens an object
  // literal is not an SSE field. Some upstreams write a late error as raw JSON
  // after the stream has started; the parser used to discard it as an unknown
  // field, which hid the failure behind an apparently clean EOF.
  const chunk = '{"candidates":[{"index":0}]}';
  const error = '{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}';
  const frames: { data: string }[] = [];
  for await (const frame of parseSSEStream(new Response(`data: ${chunk}\n\n${error}\n\n`).body!)) {
    frames.push({ data: frame.data });
  }
  assertEquals(frames, [{ data: chunk }, { data: error }]);
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

test('parseSSEStream reports a bare line as a raw frame, distinct from a data field', async () => {
  const chunk = '{"candidates":[{"index":0}]}';
  const frames: { kind: string; data: string; event?: string }[] = [];
  for await (const frame of parseSSEStream(new Response(`data: ${chunk}\n\n${chunk}\n\n`).body!)) {
    frames.push(frame.type === 'sse' ? { kind: frame.type, data: frame.data, ...(frame.event === undefined ? {} : { event: frame.event }) } : { kind: frame.type, data: frame.data });
  }
  // Same payload, two framings: the reader can now tell them apart.
  assertEquals(frames, [
    { kind: 'sse', data: chunk },
    { kind: 'sse-raw', data: chunk },
  ]);
});
