import { test } from 'vitest';

import { getExternalResourceFetcher, initExternalResourceFetcher } from './external-resource-fetcher.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('external resource fetcher must be initialized', () => {
  assertThrows(
    () => getExternalResourceFetcher(),
    Error,
    'External resource fetcher not initialized',
  );
});

test('external resource fetcher exposes the initialized runtime implementation', async () => {
  const expected = new Response('ok');
  initExternalResourceFetcher(() => Promise.resolve(expected));

  const fetcher = getExternalResourceFetcher();
  assertEquals(await fetcher(new URL('https://example.com/image.png'), new AbortController().signal), expected);
});
