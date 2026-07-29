import { test } from 'vitest';

import { normalizeDomainEntry, normalizeDomainList } from '../../../../src/data-plane/tools/web-search/domain-normalize.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('normalizeDomainEntry trims and lowercases bare hostnames', () => {
  assertEquals(normalizeDomainEntry('  Example.COM  '), 'example.com');
  assertEquals(normalizeDomainEntry('react.dev'), 'react.dev');
  assertEquals(normalizeDomainEntry('Sub.Example.Org'), 'sub.example.org');
});

test('normalizeDomainEntry rejects empty, whitespace-only, single-label, or non-hostname inputs', () => {
  assertEquals(normalizeDomainEntry(''), null);
  assertEquals(normalizeDomainEntry('   '), null);
  assertEquals(normalizeDomainEntry('localhost'), null);
  // Query-operator smuggling through site filters.
  assertEquals(normalizeDomainEntry('example.com OR site:evil.com'), null);
  assertEquals(normalizeDomainEntry('bad.com test'), null);
  assertEquals(normalizeDomainEntry('https://example.com'), null);
  assertEquals(normalizeDomainEntry('example.com/path'), null);
  assertEquals(normalizeDomainEntry('example.com:8080'), null);
  assertEquals(normalizeDomainEntry('-example.com'), null);
  assertEquals(normalizeDomainEntry('example-.com'), null);
});

test('normalizeDomainList drops invalid entries and keeps valid ones in order', () => {
  assertEquals(
    normalizeDomainList(['  Example.COM  ', 'invalid entry', 'react.dev', '']),
    ['example.com', 'react.dev'],
  );
  assertEquals(normalizeDomainList(undefined), []);
  assertEquals(normalizeDomainList([]), []);
});

// Cross-site parity: the same input must be treated identically by the
// local URL-allowed filter, the Tavily request builder, and the
// Microsoft Web IQ query builder. All three route through these
// helpers; this test pins down the contract.
test('normalizeDomainEntry parity contract for the three call sites', () => {
  const input = '  Example.COM  ';
  assertEquals(normalizeDomainList([input]), ['example.com']);
  assertEquals(normalizeDomainEntry(input), 'example.com');
});
