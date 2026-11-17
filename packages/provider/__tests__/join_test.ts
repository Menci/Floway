import { test } from 'vitest';

import { joinBaseAndPath, validateUpstreamPath } from '../src/join.ts';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

test('validateUpstreamPath rejects paths without a leading slash', () => {
  const result = validateUpstreamPath('v1/chat/completions', 'chat');
  assertFalse(result.ok);
});

test('validateUpstreamPath rejects relative segments', () => {
  for (const bad of ['/api/./chat', '/api/../chat']) {
    const result = validateUpstreamPath(bad, 'chat');
    assertFalse(result.ok, `expected ${bad} to be rejected`);
  }
});

test('joinBaseAndPath preserves a base subpath', () => {
  assertEquals(joinBaseAndPath('https://host.example/api', '/v1/messages'), 'https://host.example/api/v1/messages');
});
