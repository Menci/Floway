import { test } from 'vitest';

import { createCloudflareExternalResourceFetcher } from './external-resource-fetcher.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Cloudflare external fetches expose redirects without forwarding credentials', async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const expected = new Response(null, { status: 302, headers: { location: '/next' } });
  const fetcher = createCloudflareExternalResourceFetcher((input, init) => {
    capturedUrl = input as URL;
    capturedInit = init;
    return Promise.resolve(expected);
  });
  const signal = new AbortController().signal;

  const response = await fetcher(new URL('https://example.com/image.png'), signal);

  assertEquals(response, expected);
  assertEquals(capturedUrl?.href, 'https://example.com/image.png');
  assertEquals(capturedInit?.redirect, 'manual');
  assertEquals(capturedInit?.signal, signal);
  assertEquals(capturedInit?.headers, undefined);
});
