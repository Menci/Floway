import { describe, expect, test } from 'vitest';

import { filterInboundHeaderEntries } from '../../../src/data-plane/shared/inbound-headers.ts';
import type { HeaderEntry } from '@floway-dev/http';

describe('filterInboundHeaderEntries', () => {
  test('matches exact names case-insensitively and strips every other name', () => {
    const source: HeaderEntry[] = [
      ['authorization', 'Bearer secret'], ['x-client-request-id', 'request-1'], ['x-debug', 'discard'],
    ];

    expect(filterInboundHeaderEntries(source, ['X-Client-Request-ID'])).toEqual([['x-client-request-id', 'request-1']]);
    expect(source).toHaveLength(3);
  });

  test('matches regular expressions against lowercase names without retaining matcher state', () => {
    const matcher = /^x-trace-(?:one|two)$/g;
    const filtered = filterInboundHeaderEntries([
      ['x-trace-one', '1'], ['x-trace-two', '2'], ['x-trace-three', '3'],
    ], [matcher]);

    expect(filtered).toEqual([['x-trace-one', '1'], ['x-trace-two', '2']]);
    expect(matcher.lastIndex).toBe(0);
  });
});

test('independent provider allowlists leave the source headers usable for failover', () => {
  const source: HeaderEntry[] = [
    ['authorization', 'Bearer secret'], ['user-agent', 'claude-cli/2.1.181'], ['x-client-request-id', 'request-1'],
  ];
  expect(filterInboundHeaderEntries(source, [])).toEqual([]);
  expect(filterInboundHeaderEntries(source, ['user-agent', 'x-client-request-id'])).toEqual(source.slice(1));
  expect(source[0]).toEqual(['authorization', 'Bearer secret']);
});
