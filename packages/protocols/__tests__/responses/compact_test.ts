import { test } from 'vitest';

import { toCompactPayloadShape } from '../../src/responses/compact.ts';
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

test('toCompactPayloadShape strips every generate-only and unknown field', () => {
  assertEquals(toCompactPayloadShape({
    input: [],
    instructions: null,
    service_tier: 'future-tier',
    temperature: 1,
    stream: true,
    tools: [{ type: 'function', name: 'tool' }],
    reasoning: { effort: 'high' },
    vendor_extension: 'must not leak',
  } as never), {
    input: [],
    instructions: null,
    service_tier: 'future-tier',
  });
});
