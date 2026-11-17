import { test } from 'vitest';

import { toCompactPayloadShape } from '../../src/openai-responses/compact.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('toCompactPayloadShape preserves compact cache controls', () => {
  assertEquals(toCompactPayloadShape({
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    prompt_cache_key: 'cache-key',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    prompt_cache_retention: '24h',
    store: true,
  }), {
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    prompt_cache_key: 'cache-key',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    prompt_cache_retention: '24h',
  });
});
