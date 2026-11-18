import { test } from 'vitest';

import { joinBaseAndPath, validateUpstreamPath } from '../src/join.ts';
import { assertEquals, assertFalse } from '@floway-dev/test-utils';

test('validateUpstreamPath rejects relative segments', () => {
  assertFalse(validateUpstreamPath('/api/../chat', 'chat').ok);
});

test('joinBaseAndPath preserves a base subpath', () => {
  assertEquals(joinBaseAndPath('https://host.example/api', '/v1/messages'), 'https://host.example/api/v1/messages');
});
