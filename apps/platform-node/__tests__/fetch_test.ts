import { afterEach, expect, test, vi } from 'vitest';

import { nodeFetch } from '../src/fetch.ts';

afterEach(() => vi.unstubAllGlobals());

test('opens a replayable body with fixed framing and Node duplex', async () => {
  let observed: RequestInit | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    observed = init;
    return new Response('ok');
  }));

  await nodeFetch('https://example.com', {
    method: 'POST',
    body: { contentLength: 7, open: () => new Blob(['payload']).stream() },
  });

  expect(observed?.headers instanceof Headers && observed.headers.get('content-length')).toBe('7');
  expect((observed as RequestInit & { duplex?: string }).duplex).toBe('half');
  expect(await new Response(observed?.body).text()).toBe('payload');
});
