import { expect, test } from 'vitest';

import { createCloudflareExternalResourceFetcher } from '../src/external-resource-fetcher.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Cloudflare external fetches expose redirects without forwarding credentials', async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const expected = new Error('fetch sentinel');
  const fetchImpl: typeof fetch = (input, init) => {
    capturedUrl = input as URL;
    capturedInit = init;
    return Promise.reject(expected);
  };
  const fetcher = createCloudflareExternalResourceFetcher(fetchImpl);
  const signal = new AbortController().signal;

  await expect(fetcher(new URL('https://example.com/image.png'), signal)).rejects.toBe(expected);

  assertEquals(capturedUrl?.href, 'https://example.com/image.png');
  assertEquals(capturedInit?.redirect, 'manual');
  assertEquals(capturedInit?.signal, signal);
  assertEquals(capturedInit?.headers, undefined);
});
