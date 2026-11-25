import { afterEach, expect, test, vi } from 'vitest';

import { cloudflareFetch, cloudflareProviderFetch } from '../src/fetch.ts';
import { sendHttpRequest, UpstreamTransportError } from '@floway-dev/http';

afterEach(() => vi.unstubAllGlobals());

test('pipes a replayable body through Workers fixed-length framing', async () => {
  let observedContentLength: number | undefined;
  let observedPayload: string | undefined;
  let observed: RequestInit | undefined;
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<ArrayBufferView, Uint8Array> {
    constructor(contentLength: number) {
      super();
      observedContentLength = contentLength;
    }
  });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    observed = init;
    observedPayload = await new Response(init?.body).text();
    return new Response('ok');
  }));

  await cloudflareFetch('https://example.com', {
    method: 'POST',
    body: { contentLength: 7, open: () => new Blob(['payload']).stream() },
  });

  expect(observedContentLength).toBe(7);
  expect(observedPayload).toBe('payload');
  expect((observed as RequestInit & { duplex?: string }).duplex).toBeUndefined();
});

test('returns an early response when the upstream stops consuming the upload', async () => {
  const stopped = new Error('upstream stopped reading');
  const cancel = vi.fn();
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<ArrayBufferView, Uint8Array> {
    constructor(_contentLength: number) {
      super();
    }
  });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel(stopped);
    return new Response('too large', { status: 413 });
  }));

  const response = await cloudflareFetch('https://example.com', {
    method: 'POST',
    body: {
      contentLength: 2,
      open: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2]));
        },
        cancel,
      }),
    },
  });

  expect(response.status).toBe(413);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(stopped));
});

test.each(['disconnect', 'unmarked', 'type error'] as const)('checks the exact workerd disconnect shape for %s', async kind => {
  const failure = kind === 'type error' ? new TypeError('Network connection lost.') : new Error('Network connection lost.');
  if (kind !== 'unmarked') Object.assign(failure, { retryable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.error(failure); },
  }))));
  const result = await sendHttpRequest(cloudflareProviderFetch, { url: 'https://example.com', method: 'GET', headers: [], body: null }, new AbortController().signal);
  if (!result.ok || result.value.body === null) throw new Error('Expected HTTP response bytes');
  const pending = result.value.body.next();
  if (kind === 'disconnect') {
    await expect(pending).resolves.toMatchObject({ done: false, value: { ok: false, error: { kind: 'transport', cause: expect.any(UpstreamTransportError) } } });
    await expect(result.value.body.next()).resolves.toMatchObject({ done: true });
  } else {
    await expect(pending).rejects.toBe(failure);
  }
});
