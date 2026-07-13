import { test } from 'vitest';

import { ResponsesItemHashCache } from './hash-cache.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('content hashes are cached by item identity', async () => {
  let calls = 0;
  const cache = new ResponsesItemHashCache({
    content: async () => `content-${++calls}`,
    encryptedContent: async () => 'unused',
  });
  const item: ResponsesInputItem = { type: 'message', role: 'user', content: 'hello' };

  const first = cache.content(item);
  const second = cache.content(item);
  assert(first === second);
  assertEquals(await first, 'content-1');
  assertEquals(await cache.content(structuredClone(item)), 'content-2');
  assertEquals(calls, 2);
});

test('encrypted content hashes are cached by string value', async () => {
  let calls = 0;
  const cache = new ResponsesItemHashCache({
    content: async () => 'unused',
    encryptedContent: async () => `encrypted-${++calls}`,
  });

  const first = cache.encryptedContent('opaque-content');
  const second = cache.encryptedContent(`opaque-${'content'}`);
  assert(first === second);
  assertEquals(await first, 'encrypted-1');
  assertEquals(calls, 1);
});
