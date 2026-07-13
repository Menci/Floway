import { test } from 'vitest';

import { toCompactPayloadShape } from './index.ts';
import { assertEquals } from '../test-assert.ts';

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

test('toCompactPayloadShape forwards future cache control values verbatim', () => {
  assertEquals(toCompactPayloadShape({
    input: [],
    prompt_cache_options: { mode: 'future_mode', ttl: '1h' },
    prompt_cache_retention: 'future_retention',
  }), {
    input: [],
    prompt_cache_options: { mode: 'future_mode', ttl: '1h' },
    prompt_cache_retention: 'future_retention',
  });
});
