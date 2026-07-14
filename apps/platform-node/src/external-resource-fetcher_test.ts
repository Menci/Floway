import { test } from 'vitest';

import { createNodeExternalResourceFetcher, isPublicIpAddress } from './external-resource-fetcher.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('Node external-resource egress accepts only globally routable addresses', () => {
  assertEquals(isPublicIpAddress('8.8.8.8'), true);
  assertEquals(isPublicIpAddress('2606:4700:4700::1111'), true);

  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assertEquals(isPublicIpAddress(address), false, address);
  }
});

test('Node external-resource fetcher rejects private IP literals before connecting', async () => {
  const fetcher = createNodeExternalResourceFetcher();
  await assertRejects(
    () => fetcher(new URL('http://127.0.0.1:9/private'), new AbortController().signal),
    Error,
    'fetch failed',
  );
});
