import { afterEach, expect, test, vi } from 'vitest';

import { cloudflareFetch } from '../src/fetch.ts';

afterEach(() => vi.unstubAllGlobals());

test('pipes a replayable body through Workers fixed-length framing', async () => {
  let observedPayload: string | undefined;
  let observed: RequestInit | undefined;
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<ArrayBufferView, Uint8Array> {
    constructor(_contentLength: number) {
      super();
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

  expect(observedPayload).toBe('payload');
  expect((observed as RequestInit & { duplex?: string }).duplex).toBeUndefined();
});
