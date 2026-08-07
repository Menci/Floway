import { afterEach, expect, test, vi } from 'vitest';

import { cloudflareFetch } from '../src/fetch.ts';

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
