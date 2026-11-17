import { test } from 'vitest';

import { normalizeDomainEntry, normalizeDomainList } from '../../../../src/data-plane/tools/web-search/domain-normalize.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('normalizeDomainEntry rejects empty, single-label, or non-hostname inputs', () => {
  assertEquals(normalizeDomainEntry(''), null);
  assertEquals(normalizeDomainEntry('localhost'), null);
  // Query-operator smuggling through site filters.
  assertEquals(normalizeDomainEntry('example.com OR site:evil.com'), null);
  assertEquals(normalizeDomainEntry('https://example.com'), null);
  assertEquals(normalizeDomainEntry('example.com/path'), null);
  assertEquals(normalizeDomainEntry('example.com:8080'), null);
  assertEquals(normalizeDomainEntry('-example.com'), null);
});

test('normalizeDomainList drops invalid entries and keeps valid ones in order', () => {
  assertEquals(
    normalizeDomainList(['  Example.COM  ', 'invalid entry', 'react.dev', '']),
    ['example.com', 'react.dev'],
  );
});
