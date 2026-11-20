import { test } from 'vitest';

import { normalizeDomainList } from '../../../../src/data-plane/tools/web-search/domain-normalize.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('normalizeDomainList keeps normalized hostnames in order and drops everything else', () => {
  assertEquals(
    // `site:` smuggling, single labels, schemes, paths and ports are all
    // rejected by the same hostname pattern.
    normalizeDomainList(['  Example.COM  ', 'example.com OR site:evil.com', 'localhost', 'https://example.com', 'example.com:8080', 'react.dev', '']),
    ['example.com', 'react.dev'],
  );
});
