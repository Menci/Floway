import { expect, test, vi } from 'vitest';

import {
  fetchUpstreamModels,
  httpResponseToResponse,
  ProviderModelsUnavailableError,
  readBoundedJsonResponse,
  ResponseByteBudget,
  runProviderModelsTask,
} from '../src/models-fetch.ts';
import { assertRejects } from '@floway-dev/test-utils';

const runReadyMicrotasksFor = async (durationMs: number): Promise<void> => {
  const deadline = performance.now() + durationMs;
  while (performance.now() < deadline) await Promise.resolve();
};

const blockEventLoopFor = (durationMs: number): number => {
  const deadline = performance.now() + durationMs;
  let iterations = 0;
  while (performance.now() < deadline) iterations++;
  return iterations;
};

test('fetchUpstreamModels accepts the byte boundary and cancels an oversized success body', async () => {
  const json = '{"ok":true}';
  const bytes = new TextEncoder().encode(json);
  await expect(fetchUpstreamModels(
    () => Promise.resolve(new Response(bytes)),
    value => value as { ok: boolean },
    { maxResponseBytes: bytes.byteLength },
  )).resolves.toEqual({ ok: true });

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 6));
      controller.enqueue(bytes.slice(6));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body)),
    value => value,
    { maxResponseBytes: bytes.byteLength - 1 },
  );
  const error = await assertRejects(() => result, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(error).toMatchObject({
    name: 'ProviderModelsUnavailableError',
    cause: expect.objectContaining({ message: `Provider model listing exceeded ${bytes.byteLength - 1} response bytes` }),
  } satisfies Partial<ProviderModelsUnavailableError>);
  expect(cancelled).toBe(true);
});

test('fetchUpstreamModels aggregates response overflow with a prompt cancellation failure', async () => {
  const cleanupError = new Error('response cancellation failed');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2]));
    },
    cancel() {
      return Promise.reject(cleanupError);
    },
  });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body)),
    value => value,
    { maxResponseBytes: 1 },
  );
  const error = await assertRejects(() => result, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(error.cause).toBeInstanceOf(AggregateError);
  const aggregate = error.cause as AggregateError;
  expect(aggregate.errors).toHaveLength(2);
  expect(aggregate.errors[0]).toMatchObject({ message: 'Provider model listing exceeded 1 response bytes' });
  expect(aggregate.errors[1]).toBe(cleanupError);
  expect(aggregate.cause).toBe(aggregate.errors[0]);
});

test('fetchUpstreamModels bounds non-2xx bodies while preserving status and headers', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('rate-'));
      controller.enqueue(new TextEncoder().encode('limited'));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body, {
      status: 429,
      headers: {
        'content-digest': 'sha-256=:invalid-after-truncation:',
        'content-encoding': 'gzip',
        'content-length': '999',
        'content-type': 'application/json; profile="urn:floway"',
        'retry-after': '5',
      },
    })),
    value => value,
    { maxErrorResponseBytes: 8 },
  );
  const error = await assertRejects(() => result, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(error).toMatchObject({
    name: 'ProviderModelsUnavailableError',
    httpResponse: {
      status: 429,
      body: 'rate-lim...[truncated]',
    },
  });
  expect(error.httpResponse?.headers.get('retry-after')).toBe('5');
  expect(error.httpResponse?.headers.get('content-length')).toBeNull();
  expect(error.httpResponse?.headers.get('content-encoding')).toBeNull();
  expect(error.httpResponse?.headers.get('content-digest')).toBeNull();
  expect(error.httpResponse?.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  const reconstructed = httpResponseToResponse(error.httpResponse);
  expect(reconstructed?.status).toBe(429);
  expect(reconstructed?.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await reconstructed?.text()).toBe('rate-lim...[truncated]');
  expect(cancelled).toBe(true);
});

test('fetchUpstreamModels preserves semantic content-type parameters while clearing stale entity metadata', async () => {
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response('small', {
      status: 500,
      headers: {
        'accept-ranges': 'bytes',
        'content-encoding': 'gzip',
        'content-length': '5',
        'content-range': 'bytes 0-4/5',
        'content-type': 'application/problem+json; profile="urn:floway;models"; charset=iso-8859-1',
        etag: '"stale"',
        'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'repr-digest': 'sha-256=:stale:',
      },
    })),
    value => value,
  );
  const error = await assertRejects(() => result, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(error.httpResponse?.body).toBe('small');
  expect(error.httpResponse?.headers.get('content-encoding')).toBeNull();
  expect(error.httpResponse?.headers.get('content-length')).toBeNull();
  expect(error.httpResponse?.headers.get('repr-digest')).toBeNull();
  expect(error.httpResponse?.headers.get('etag')).toBeNull();
  expect(error.httpResponse?.headers.get('last-modified')).toBeNull();
  expect(error.httpResponse?.headers.get('content-range')).toBeNull();
  expect(error.httpResponse?.headers.get('accept-ranges')).toBeNull();
  expect(error.httpResponse?.headers.get('content-type')).toBe('application/problem+json; profile="urn:floway;models"; charset=utf-8');
});

test('fetchUpstreamModels enforces the total deadline while body reads remain continuously ready', async () => {
  let cancelReason: unknown;
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (reads <= 50_000) controller.enqueue(new Uint8Array([0x20]));
      else {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      }
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body)),
    value => value,
    { idleTimeoutMs: 1000, maxResponseBytes: 100_000, totalTimeoutMs: 5 },
  );
  const error = await assertRejects(() => result, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(error.cause).toMatchObject({ name: 'TimeoutError' });
  expect(cancelReason).toBe(error.cause);
  expect(reads).toBeLessThan(50_001);
});

test('runProviderModelsTask gives elapsed deadlines precedence at opaque task settlement', async () => {
  const completed = runProviderModelsTask(async () => {
    await runReadyMicrotasksFor(8);
    return 'completed';
  }, { totalTimeoutMs: 1 });
  await expect(completed).rejects.toMatchObject({ name: 'TimeoutError' });

  const lateFailure = new Error('late task failure');
  const rejected = runProviderModelsTask(async () => {
    await runReadyMicrotasksFor(8);
    throw lateFailure;
  }, { totalTimeoutMs: 1 });
  const rejection = await rejected.catch(error => error as unknown);
  expect(rejection).toMatchObject({ name: 'TimeoutError' });
  expect(rejection).not.toBe(lateFailure);
});

test('fetchUpstreamModels enforces the deadline after blocking parse and late bodyless errors', async () => {
  const parsed = fetchUpstreamModels(
    () => Promise.resolve(new Response('{}')),
    value => {
      expect(blockEventLoopFor(8)).toBeGreaterThan(0);
      return value;
    },
    { totalTimeoutMs: 1 },
  );
  const parseError = await assertRejects(() => parsed, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(parseError.httpResponse).toBeNull();
  expect(parseError.cause).toMatchObject({ name: 'TimeoutError' });

  const bodyless = fetchUpstreamModels(
    () => {
      expect(blockEventLoopFor(8)).toBeGreaterThan(0);
      return Promise.resolve(new Response(null, { status: 503, headers: { 'retry-after': '9' } }));
    },
    value => value,
    { totalTimeoutMs: 1 },
  );
  const bodylessError = await assertRejects(() => bodyless, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(bodylessError.httpResponse).toBeNull();
  expect(bodylessError.cause).toMatchObject({ name: 'TimeoutError' });
});

test('fetchUpstreamModels yields ready success and error bodies to caller cancellation', async () => {
  for (const status of [200, 500]) {
    const controller = new AbortController();
    const reason = new DOMException(`cancel ${status}`, 'AbortError');
    let cancelReason: unknown;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pulls++;
        streamController.enqueue(new Uint8Array());
      },
      cancel(cause) {
        cancelReason = cause;
      },
    }, { highWaterMark: 0 });
    const result = fetchUpstreamModels(
      () => Promise.resolve(new Response(body, { status })),
      value => value,
      { idleTimeoutMs: 1000, signal: controller.signal, totalTimeoutMs: 1000 },
    );
    const timer = setTimeout(() => controller.abort(reason), 0);
    await expect(result).rejects.toBe(reason);
    clearTimeout(timer);
    await Promise.resolve();
    expect(cancelReason).toBe(reason);
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThan(1000);
  }
});

test('zero-byte chunks neither reset the idle deadline nor enter the captured body', async () => {
  let cancelReason: unknown;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array());
    },
    cancel(reason) {
      cancelReason = reason;
    },
  }, { highWaterMark: 0 });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body)),
    value => value,
    { idleTimeoutMs: 5, maxResponseBytes: 1, totalTimeoutMs: 35 },
  );
  const error = await assertRejects(() => result, ProviderModelsUnavailableError) as ProviderModelsUnavailableError;
  expect(error.cause).toMatchObject({
    message: 'Provider model listing idle timeout after 5ms',
    name: 'TimeoutError',
  });
  expect(cancelReason).toBe(error.cause);
  expect(pulls).toBeGreaterThan(0);
  expect(pulls).toBeLessThan(1000);
});

test('readBoundedJsonResponse observes an abort raised synchronously by the source pull', async () => {
  const controller = new AbortController();
  const reason = new DOMException('pull cancelled', 'AbortError');
  let cancelReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      controller.abort(reason);
      return new Promise<void>(() => {});
    },
    cancel(cause) {
      cancelReason = cause;
    },
  }, { highWaterMark: 0 });
  await expect(readBoundedJsonResponse(
    new Response(body),
    16,
    undefined,
    { idleTimeoutMs: 1000, signal: controller.signal },
  )).rejects.toBe(reason);
  expect(cancelReason).toBe(reason);
  expect(body.locked).toBe(false);
});

test('fetchUpstreamModels preserves a known non-2xx frame when its total deadline expires while reading the body', async () => {
  vi.useFakeTimers();
  try {
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const result = fetchUpstreamModels(
      () => Promise.resolve(new Response(body, {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '5' },
      })),
      value => value,
      { idleTimeoutMs: 1000, totalTimeoutMs: 25 },
    );
    const rejection = assertRejects(() => result, ProviderModelsUnavailableError) as Promise<ProviderModelsUnavailableError>;
    await vi.advanceTimersByTimeAsync(25);
    const error = await rejection;
    expect(error.httpResponse).toMatchObject({ status: 429, body: '' });
    expect(error.httpResponse?.headers.get('retry-after')).toBe('5');
    expect(error.httpResponse?.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(error.cause).toMatchObject({ name: 'TimeoutError' });
    expect(cancelReason).toBe(error.cause);
  } finally {
    vi.useRealTimers();
  }
});

test('fetchUpstreamModels preserves a non-2xx frame through an inherited task deadline', async () => {
  vi.useFakeTimers();
  try {
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const result = runProviderModelsTask(
      outerSignal => fetchUpstreamModels(
        () => Promise.resolve(new Response(body, {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '7' },
        })),
        value => value,
        { idleTimeoutMs: 1000, signal: outerSignal, totalTimeoutMs: 1000 },
      ),
      { totalTimeoutMs: 25 },
    );
    const rejection = assertRejects(() => result, ProviderModelsUnavailableError) as Promise<ProviderModelsUnavailableError>;
    await vi.advanceTimersByTimeAsync(25);
    const error = await rejection;
    expect(error.httpResponse).toMatchObject({ status: 429, body: '' });
    expect(error.httpResponse?.headers.get('retry-after')).toBe('7');
    expect(error.httpResponse?.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(error.cause).toMatchObject({ name: 'TimeoutError' });
    expect(cancelReason).toBe(error.cause);
  } finally {
    vi.useRealTimers();
  }
});

test('parallel inherited deadlines preserve each child frame without cross-contamination', async () => {
  vi.useFakeTimers();
  try {
    const childPromises: Array<Promise<unknown>> = [];
    const cancellations = new Map<string, unknown>();
    const result = runProviderModelsTask(outerSignal => {
      const children = ['A', 'B'].map(child => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`partial-${child}`));
          },
          pull() {
            return new Promise<void>(() => {});
          },
          cancel(reason) {
            cancellations.set(child, reason);
          },
        });
        return fetchUpstreamModels(
          () => Promise.resolve(new Response(body, {
            status: 429,
            headers: { 'content-type': 'application/json', 'x-child': child },
          })),
          value => value,
          { idleTimeoutMs: 1000, signal: outerSignal, totalTimeoutMs: 1000 },
        );
      });
      childPromises.push(...children);
      return Promise.all(children);
    }, { totalTimeoutMs: 25 });
    const outerRejection = result.catch(error => error as unknown);
    await vi.advanceTimersByTimeAsync(0);
    expect(childPromises).toHaveLength(2);
    const childRejections = childPromises.map(child => child.catch(error => error as unknown));
    await vi.advanceTimersByTimeAsync(25);
    const [outerError, childA, childB] = await Promise.all([outerRejection, ...childRejections]);
    expect(childA).toBeInstanceOf(ProviderModelsUnavailableError);
    expect(childB).toBeInstanceOf(ProviderModelsUnavailableError);
    const errorA = childA as ProviderModelsUnavailableError;
    const errorB = childB as ProviderModelsUnavailableError;
    expect(errorA.httpResponse?.headers.get('x-child')).toBe('A');
    expect(errorB.httpResponse?.headers.get('x-child')).toBe('B');
    expect(errorA.cause).toBe(errorB.cause);
    expect(cancellations.get('A')).toBe(errorA.cause);
    expect(cancellations.get('B')).toBe(errorB.cause);
    expect(outerError).toBe(errorA.cause);
    expect(outerError).toMatchObject({ name: 'TimeoutError' });
    expect(outerError).not.toBe(errorA);
    expect(outerError).not.toBe(errorB);
  } finally {
    vi.useRealTimers();
  }
});

test('model task timers reject durations the runtime cannot represent before dispatch', async () => {
  const task = vi.fn<() => Promise<void>>(() => Promise.resolve());
  await expect(runProviderModelsTask(task, { totalTimeoutMs: 2_147_483_648 })).rejects.toThrow(
    'totalTimeoutMs must be a positive safe integer no greater than 2147483647',
  );
  expect(task).not.toHaveBeenCalled();

  const doFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response('{}')));
  await expect(fetchUpstreamModels(doFetch, value => value, { idleTimeoutMs: 2_147_483_648 })).rejects.toThrow(
    'idleTimeoutMs must be a positive safe integer no greater than 2147483647',
  );
  expect(doFetch).not.toHaveBeenCalled();
});

test('fetchUpstreamModels validates idle timeouts and byte budgets before dispatch', async () => {
  const invalidIdleFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response('{}')));
  await expect(fetchUpstreamModels(invalidIdleFetch, value => value, { idleTimeoutMs: 0 })).rejects.toThrow(
    'idleTimeoutMs must be a positive safe integer',
  );
  expect(invalidIdleFetch).not.toHaveBeenCalled();

  const invalidBudgetFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response('{}')));
  await expect(fetchUpstreamModels(
    invalidBudgetFetch,
    value => value,
    { responseByteBudget: { remainingBytes: -1 } as unknown as ResponseByteBudget },
  )).rejects.toThrow('response byte budget must be created by ResponseByteBudget.create');
  expect(invalidBudgetFetch).not.toHaveBeenCalled();

  const exhaustedBudgetFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response('{}')));
  const exhausted = await assertRejects(
    () => fetchUpstreamModels(
      exhaustedBudgetFetch,
      value => value,
      { responseByteBudget: ResponseByteBudget.create(0) },
    ),
    ProviderModelsUnavailableError,
  ) as ProviderModelsUnavailableError;
  expect(exhausted.cause).toMatchObject({ message: 'Provider model listing exhausted its response byte budget' });
  expect(exhaustedBudgetFetch).not.toHaveBeenCalled();
});

test('ResponseByteBudget reserves concurrent capacity atomically and refunds only unused bytes', () => {
  const budget = ResponseByteBudget.create(10);
  const first = budget.reserve(6);
  const second = budget.reserve(6);

  expect(first.remainingBytes).toBe(6);
  expect(second.remainingBytes).toBe(4);
  expect(budget.remainingBytes).toBe(0);
  expect(() => budget.reserve(1)).toThrow('Provider model listing exhausted its response byte budget');

  first.consume(4);
  first.release();
  expect(budget.remainingBytes).toBe(2);
  second.consume(4);
  second.release();
  expect(budget.remainingBytes).toBe(2);

  const final = budget.reserve(2);
  final.consume(2);
  final.release();
  expect(budget.remainingBytes).toBe(0);
  expect(() => first.remainingBytes).toThrow('Response byte budget reservation was already released');
});

test('readBoundedJsonResponse cancels bodies it owns when pre-read validation rejects', async () => {
  const cancellationReasons: unknown[] = [];
  const invalidIdleBody = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancellationReasons.push(reason);
    },
  });
  await expect(readBoundedJsonResponse(
    new Response(invalidIdleBody),
    16,
    undefined,
    { idleTimeoutMs: 0 },
  )).rejects.toThrow('idleTimeoutMs must be a positive safe integer');

  const exhaustedBody = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancellationReasons.push(reason);
    },
  });
  await expect(readBoundedJsonResponse(
    new Response(exhaustedBody),
    16,
    ResponseByteBudget.create(0),
  )).rejects.toThrow('Provider model listing exhausted its response byte budget');

  expect(cancellationReasons).toHaveLength(2);
  expect(cancellationReasons[0]).toBeInstanceOf(TypeError);
  expect(cancellationReasons[1]).toMatchObject({ message: 'Provider model listing exhausted its response byte budget' });
  expect(invalidIdleBody.locked).toBe(false);
  expect(exhaustedBody.locked).toBe(false);
});

test('fetchUpstreamModels aborts total stalls and preserves caller cancellation reasons', async () => {
  vi.useFakeTimers();
  try {
    let upstreamTimeoutReason: unknown;
    const stalled = fetchUpstreamModels(
      signal => new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          upstreamTimeoutReason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      }),
      value => value,
      { totalTimeoutMs: 50 },
    );
    const timeoutAssertion = expect(stalled).rejects.toMatchObject({
      name: 'ProviderModelsUnavailableError',
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    });
    await vi.advanceTimersByTimeAsync(50);
    await timeoutAssertion;
    expect(upstreamTimeoutReason).toMatchObject({ name: 'TimeoutError' });

    const controller = new AbortController();
    const cancellation = new DOMException('caller cancelled', 'AbortError');
    const cancelled = fetchUpstreamModels(
      signal => new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      value => value,
      { signal: controller.signal, totalTimeoutMs: 1000 },
    );
    const cancellationAssertion = expect(cancelled).rejects.toBe(cancellation);
    controller.abort(cancellation);
    await cancellationAssertion;
  } finally {
    vi.useRealTimers();
  }
});

test('an internal deadline keeps precedence when its abort handler triggers a later caller abort', async () => {
  vi.useFakeTimers();
  try {
    const caller = new AbortController();
    const laterAbort = new DOMException('later caller abort', 'AbortError');
    let internalReason: unknown;
    const result = fetchUpstreamModels(
      signal => new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          internalReason = signal.reason;
          caller.abort(laterAbort);
          reject(signal.reason);
        }, { once: true });
      }),
      value => value,
      { signal: caller.signal, totalTimeoutMs: 25 },
    );
    const rejection = assertRejects(() => result, ProviderModelsUnavailableError) as Promise<ProviderModelsUnavailableError>;
    await vi.advanceTimersByTimeAsync(25);
    const error = await rejection;
    expect(error.cause).toBe(internalReason);
    expect(error.cause).toMatchObject({ name: 'TimeoutError' });
    expect(error.cause).not.toBe(laterAbort);
  } finally {
    vi.useRealTimers();
  }
});

test('fetchUpstreamModels aborts a stalled body after the idle timeout', async () => {
  vi.useFakeTimers();
  try {
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const stalled = fetchUpstreamModels(
      () => Promise.resolve(new Response(body)),
      value => value,
      { idleTimeoutMs: 25, totalTimeoutMs: 1000 },
    );
    const assertion = expect(stalled).rejects.toMatchObject({
      name: 'ProviderModelsUnavailableError',
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(cancelReason).toMatchObject({ name: 'TimeoutError' });
  } finally {
    vi.useRealTimers();
  }
});
