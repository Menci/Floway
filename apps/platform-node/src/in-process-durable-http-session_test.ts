import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { InProcessDurableHttpSession } from './in-process-durable-http-session.ts';

const mockFetch = (factory: () => Response | Promise<Response>): typeof globalThis.fetch =>
  vi.fn(async () => await factory()) as unknown as typeof globalThis.fetch;

const collectBody = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};

const makeResponse = (status: number, headers: Record<string, string>, chunks: Uint8Array[]): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('InProcessDurableHttpSession.acquire', () => {
  test('returns null on miss when init is null', async () => {
    const broker = new InProcessDurableHttpSession();
    const handle = await broker.acquire('k', null);
    expect(handle).toBeNull();
    expect(broker.sizeForTesting()).toBe(0);
  });

  test('seeds a new entry on miss + init non-null and exposes status/headers/body', async () => {
    globalThis.fetch = mockFetch(() => makeResponse(200, { 'x-test': 'hi' }, [new Uint8Array([1, 2, 3])]));
    const broker = new InProcessDurableHttpSession();
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });

    expect(handle).not.toBeNull();
    expect(handle!.status).toBe(200);
    expect(handle!.headers.get('x-test')).toBe('hi');
    expect(Array.from(await collectBody(handle!.body))).toEqual([1, 2, 3]);
    expect(broker.sizeForTesting()).toBe(1);
  });

  test('hit returns a handle to the cached entry on subsequent acquire(key, null)', async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(() => {
      calls++;
      return makeResponse(201, {}, [new Uint8Array([1])]);
    });
    const broker = new InProcessDurableHttpSession();
    const h1 = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    expect(h1!.status).toBe(201);
    const h2 = await broker.acquire('k', null);
    expect(h2).not.toBeNull();
    expect(h2!.status).toBe(201);
    expect(calls).toBe(1); // upstream fetch called once
  });

  test('hit + init non-null ignores init (existing session wins)', async () => {
    globalThis.fetch = mockFetch(() => makeResponse(200, {}, []));
    const broker = new InProcessDurableHttpSession();
    await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    const fetchCallsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await broker.acquire('k', { method: 'POST', url: 'https://other', headers: {} });
    const fetchCallsAfter = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(fetchCallsAfter).toBe(fetchCallsBefore); // no second upstream fetch
  });

  test('discard evicts the entry so the next acquire(key, null) misses', async () => {
    globalThis.fetch = mockFetch(() => makeResponse(200, {}, []));
    const broker = new InProcessDurableHttpSession();
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    await handle!.discard('done');
    const next = await broker.acquire('k', null);
    expect(next).toBeNull();
    expect(broker.sizeForTesting()).toBe(0);
  });

  test('idle TTL evicts the entry after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = mockFetch(() => makeResponse(200, {}, []));
      const broker = new InProcessDurableHttpSession();
      await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} }, { idleTimeoutMs: 1000 });
      expect(broker.sizeForTesting()).toBe(1);
      vi.advanceTimersByTime(1500);
      // microtask flush so the timer callback's evict runs
      await Promise.resolve();
      expect(broker.sizeForTesting()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('concurrent acquires for the same key trigger only one upstream fetch', async () => {
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls++;
      // simulate slow upstream so two acquires race
      await new Promise(resolve => setTimeout(resolve, 50));
      return makeResponse(200, {}, []);
    });
    const broker = new InProcessDurableHttpSession();
    const init = { method: 'POST' as const, url: 'https://x', headers: {} };
    const [a, b] = await Promise.all([
      broker.acquire('k', init),
      broker.acquire('k', init),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(calls).toBe(1); // dedup'd
  });

  test('release is a no-op at the session level (next acquire still hits)', async () => {
    globalThis.fetch = mockFetch(() => makeResponse(200, {}, []));
    const broker = new InProcessDurableHttpSession();
    const handle = await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    await handle!.release();
    const next = await broker.acquire('k', null);
    expect(next).not.toBeNull();
  });

  test('upstream returning no body throws on create', async () => {
    globalThis.fetch = mockFetch(() => new Response(null, { status: 204 }));
    const broker = new InProcessDurableHttpSession();
    await expect(
      broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} }),
    ).rejects.toThrow('returned no body');
    expect(broker.sizeForTesting()).toBe(0);
  });
});

describe('InProcessDurableHttpSession — Response GC anchor', () => {
  // This test verifies the architectural fix: the entry holds the Response
  // object itself, not just response.body. Without anchoring, V8 GC of the
  // Response causes "Response object has been garbage collected" errors on
  // subsequent reads. Running with --expose-gc lets us force the collection
  // to assert the entry survives.
  //
  // Skipped when --expose-gc was not passed; the test still serves as
  // documentation and runs in CI where the harness exposes gc.
  const gc = (globalThis as { gc?: () => void }).gc;
  const maybeIt = gc ? test : test.skip;

  maybeIt('survives forced GC between writes and a subsequent acquire', async () => {
    // Build an upstream that streams chunks asynchronously so the body is
    // not synchronously closed before we force GC.
    let resolveSecondChunk: ((c: Uint8Array | null) => void) | null = null;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        resolveSecondChunk = c => {
          if (c) controller.enqueue(c);
          controller.close();
        };
      },
    });
    globalThis.fetch = mockFetch(() => new Response(upstreamBody, { status: 200 }));

    const broker = new InProcessDurableHttpSession();
    let first: { body: ReadableStream<Uint8Array> } | null =
      await broker.acquire('k', { method: 'POST', url: 'https://x', headers: {} });
    const firstReader = first!.body.getReader();
    const firstChunk = await firstReader.read();
    expect(Array.from(firstChunk.value!)).toEqual([1, 2, 3]);
    firstReader.releaseLock();

    // Drop the local handle and force GC. If the entry weren't anchoring
    // the Response, the next acquire would fail when reading.
    first = null;
    gc!();
    gc!();
    await new Promise(resolve => setTimeout(resolve, 0));

    const second = await broker.acquire('k', null);
    expect(second).not.toBeNull();
    const secondReader = second!.body.getReader();
    resolveSecondChunk!(new Uint8Array([9]));
    const secondChunk = await secondReader.read();
    expect(Array.from(secondChunk.value!)).toEqual([9]);
  });
});
