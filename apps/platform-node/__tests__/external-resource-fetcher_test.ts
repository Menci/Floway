import { test } from 'vitest';

import {
  createNodeExternalResourceFetcher,
  createPublicAddressLookup,
  isPublicIpAddress,
} from '../src/external-resource-fetcher.ts';
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
    '100:0:0:1::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assertEquals(isPublicIpAddress(address), false, address);
  }
});

test.each([
  'http://127.0.0.1:8080/private',
  'http://[::1]:8080/private',
])(
  'Node external-resource fetcher rejects private target %s before connecting',
  async url => {
    const fetcher = createNodeExternalResourceFetcher();
    const error = await assertRejects(() => fetcher(new URL(url), new AbortController().signal), Error);
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    assertEquals(messages.includes('External resource target did not resolve exclusively to public IP addresses'), true);
  },
);

test('Node external-resource DNS rejects empty and mixed public/private answers', async () => {
  for (const addresses of [
    [],
    [
      { address: '8.8.8.8', family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ],
  ]) {
    const lookup = createPublicAddressLookup((_hostname, _options, callback) => callback(null, addresses));
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      lookup('example.com', { all: true }, lookupError => resolve(lookupError));
    });

    assertEquals(error?.code, 'ENETUNREACH');
    assertEquals(error?.message, 'External resource target did not resolve exclusively to public IP addresses');
  }
});

test('Node external-resource DNS preserves resolver failures', async () => {
  const expected = Object.assign(new Error('resolver failed'), { code: 'EAI_AGAIN' });
  const lookup = createPublicAddressLookup((_hostname, _options, callback) => callback(expected, []));
  const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
    lookup('example.com', { all: true }, lookupError => resolve(lookupError));
  });

  assertEquals(error, expected);
});
