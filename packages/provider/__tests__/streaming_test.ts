import { test, vi } from 'vitest';

import { streamingProviderCall } from '../src/streaming.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects, assertStringIncludes } from '@floway-dev/test-utils';

interface StubEvent { type: string }

// Stub parser: feed the body bytes through TextDecoder and yield one
// eventFrame per non-empty line, plus a terminal doneFrame. Mirrors the
// shape (but not the protocol-specific logic) of parseXxxStream so we can
// assert streamingProviderCall plumbing without dragging in protocol parsers.
const stubParser = (body: ReadableStream<Uint8Array>): AsyncIterable<ProtocolFrame<StubEvent>> => (async function* () {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  for (const line of buffer.split('\n').filter(Boolean)) {
    yield eventFrame<StubEvent>({ type: line });
  }
  yield doneFrame();
})();

test('streamingProviderCall returns ok:false when upstream is non-2xx', async () => {
  const response = new Response('rate limited', { status: 429 });
  const result = await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error('expected ok:false');
  assertEquals(result.response.status, 429);
  assertEquals(result.modelKey, 'm-1');
});

test('streamingProviderCall throws on 2xx without a body, surfacing the status and an <empty> body marker', async () => {
  // 204 is the canonical "no body" success; this is a provider-contract violation
  // because the streaming endpoints always force stream:true.
  const response = new Response(null, { status: 204 });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '204');
      assertStringIncludes((error as Error).message, 'stream is required');
      assertStringIncludes((error as Error).message, 'Body: <empty>');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall throws when 2xx content-type is not text/event-stream, including the upstream body for diagnosis', async () => {
  const response = new Response(JSON.stringify({ error: { message: 'azure stub' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '200');
      assertStringIncludes((error as Error).message, 'application/json');
      assertStringIncludes((error as Error).message, 'stream is required');
      assertStringIncludes((error as Error).message, 'azure stub');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall rejects a content-type that only starts with the SSE essence', async () => {
  const response = new Response('not really an event stream', {
    status: 200,
    headers: { 'content-type': 'text/event-stream-fake' },
  });
  await assertRejects(
    () => streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined),
    Error,
  );
});

test('streamingProviderCall surfaces "unknown" content-type when the header is missing', async () => {
  // Cloudflare Workers sometimes hands us a 200 with no content-type header
  // when the upstream response is malformed; the diagnostic must label that
  // as "unknown" rather than the empty string so the operator can grep for it.
  const response = new Response('{"choices":[]}', { status: 200 });
  await assertRejects(async () => {
    try {
      await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
    } catch (error) {
      assertStringIncludes((error as Error).message, '"unknown"');
      assertStringIncludes((error as Error).message, '{"choices":[]}');
      throw error;
    }
  }, Error);
});

test('streamingProviderCall truncates oversized bodies without waiting for cancellation that never settles', async () => {
  let cancelled = false;
  const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assertRejects(async () => {
      try {
        await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
      } catch (error) {
        assertStringIncludes((error as Error).message, '...[truncated]');
        throw error;
      }
    }, Error);
    const decodedBytes = decodeSpy.mock.calls.flatMap(([input]) => input instanceof Uint8Array ? [input.byteLength] : []);
    assertEquals(Math.max(...decodedBytes), 4096);
  } finally {
    decodeSpy.mockRestore();
  }
  assertEquals(cancelled, true);
});

test('streamingProviderCall propagates an already-aborted signal and cancels the diagnostic body with its reason', async () => {
  const reason = new DOMException('caller stopped', 'AbortError');
  const controller = new AbortController();
  controller.abort(reason);
  let cancellationReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    cancel(cancelReason) {
      cancellationReason = cancelReason;
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      controller.signal,
    ),
    Error,
  );

  assertEquals(error, reason);
  assertEquals(cancellationReason, reason);
});

test('streamingProviderCall yields through ready empty chunks so a timer can abort diagnostic work', async () => {
  const reason = new DOMException('caller stopped', 'AbortError');
  const controller = new AbortController();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      pulls++;
      stream.enqueue(new Uint8Array());
    },
  });
  const call = streamingProviderCall(
    Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
    stubParser,
    'm-1',
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(reason), 0);

  try {
    const error = await assertRejects(() => call, Error);
    assertEquals(error, reason);
    assertEquals(pulls <= 34, true);
  } finally {
    clearTimeout(timer);
  }
});

test('streamingProviderCall bounds empty diagnostic chunks even without a cancellation signal', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      pulls++;
      stream.enqueue(new Uint8Array());
    },
    cancel() {
      cancelled = true;
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    ),
    Error,
  );

  assertStringIncludes((error.cause as Error).message, '64 empty body chunks');
  assertEquals(pulls <= 66, true);
  assertEquals(cancelled, true);
});

test('streamingProviderCall gives stalled diagnostics an idle timeout', async () => {
  vi.useFakeTimers();
  try {
    let cancellationReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const call = streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    );
    const rejection = assertRejects(() => call, Error);

    await vi.advanceTimersToNextTimerAsync();
    const error = await rejection;
    assertEquals((error.cause as DOMException).name, 'TimeoutError');
    assertStringIncludes((error.cause as DOMException).message, 'idle timeout');
    assertEquals(cancellationReason, error.cause);
  } finally {
    vi.useRealTimers();
  }
});

test('streamingProviderCall gives progressing diagnostics an independent total timeout', async () => {
  vi.useFakeTimers();
  try {
    let chunks = 0;
    let cancellationReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        await new Promise(resolve => setTimeout(resolve, 500));
        chunks++;
        stream.enqueue(Uint8Array.of(120));
      },
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const call = streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    );
    const rejection = assertRejects(() => call, Error);

    await vi.runAllTimersAsync();
    const error = await rejection;
    assertEquals((error.cause as DOMException).name, 'TimeoutError');
    assertStringIncludes((error.cause as DOMException).message, 'total timeout');
    assertEquals(cancellationReason, error.cause);
    assertEquals(chunks > 1, true);
  } finally {
    vi.useRealTimers();
  }
});

test('streamingProviderCall preserves a diagnostic body read failure as the contract error cause', async () => {
  const sourceError = new Error('wire exploded');
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.error(sourceError);
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    ),
    Error,
  );

  assertEquals(error.cause, sourceError);
  assertStringIncludes(error.message, 'Body: <unreadable>');
});

test('streamingProviderCall preserves an undefined diagnostic body read failure', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.error(undefined);
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    ),
    Error,
  );

  assertEquals(Object.hasOwn(error, 'cause'), true);
  assertEquals(error.cause, undefined);
});

test('streamingProviderCall preserves immediate diagnostic cancellation failures', async () => {
  const cleanupError = new Error('cancel failed');
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    },
    cancel() {
      return Promise.reject(cleanupError);
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    ),
    Error,
  );

  assertEquals(error.cause, cleanupError);
});

test('streamingProviderCall preserves an undefined diagnostic cancellation failure', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    },
    cancel() {
      return Promise.reject(undefined);
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    ),
    Error,
  );

  assertEquals(Object.hasOwn(error, 'cause'), true);
  assertEquals(error.cause, undefined);
});

test('streamingProviderCall observes cancellation rejection after an arbitrary finite microtask chain', async () => {
  const cleanupError = new Error('delayed cancel failed');
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    },
    cancel() {
      return new Promise<void>((_resolve, reject) => {
        let pending = Promise.resolve();
        for (let turn = 0; turn < 16; turn++) pending = pending.then(() => undefined);
        void pending.then(() => reject(cleanupError));
      });
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      undefined,
    ),
    Error,
  );

  assertEquals(error.cause, cleanupError);
});

test('streamingProviderCall retains both abort and cleanup failures', async () => {
  const reason = new DOMException('caller stopped', 'AbortError');
  const cleanupError = new Error('cancel failed');
  const controller = new AbortController();
  controller.abort(reason);
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      return Promise.reject(cleanupError);
    },
  });

  const error = await assertRejects(
    () => streamingProviderCall(
      Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })),
      stubParser,
      'm-1',
      controller.signal,
    ),
    AggregateError,
  ) as AggregateError;

  assertEquals(error.cause, reason);
  assertEquals(error.errors, [reason, cleanupError]);
});

test('streamingProviderCall returns ok:true with parsed frames on 2xx SSE', async () => {
  const response = new Response('alpha\nbeta\n', {
    status: 200,
    headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' },
  });
  const result = await streamingProviderCall(Promise.resolve(response), stubParser, 'm-1', undefined);
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error('expected ok:true');
  const frames: ProtocolFrame<StubEvent>[] = [];
  for await (const frame of result.events) frames.push(frame);
  assertEquals(frames, [eventFrame({ type: 'alpha' }), eventFrame({ type: 'beta' }), doneFrame()]);
});
