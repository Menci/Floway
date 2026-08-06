import { expect, test, vi } from 'vitest';

import {
  fetchUpstreamModels,
  httpResponseToResponse,
  ProviderModelsUnavailableError,
  readBoundedJsonResponse,
  runProviderModelsTask,
} from '../src/models-fetch.ts';
import { assertRejects } from '@floway-dev/test-utils';

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
    { responseByteBudget: { remainingBytes: -1 } },
  )).rejects.toThrow('response byte budget must be a non-negative safe integer');
  expect(invalidBudgetFetch).not.toHaveBeenCalled();

  const exhaustedBudgetFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response('{}')));
  const exhausted = await assertRejects(
    () => fetchUpstreamModels(
      exhaustedBudgetFetch,
      value => value,
      { responseByteBudget: { remainingBytes: 0 } },
    ),
    ProviderModelsUnavailableError,
  ) as ProviderModelsUnavailableError;
  expect(exhausted.cause).toMatchObject({ message: 'Provider model listing exhausted its response byte budget' });
  expect(exhaustedBudgetFetch).not.toHaveBeenCalled();
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
    { remainingBytes: 0 },
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
