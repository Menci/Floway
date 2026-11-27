import { expect, test } from 'vitest';

import { parseJSONWithRawNumbers } from '../../src/common/json.ts';
import { type CanonicalOpenAIResponsesCompactPayload, decodeOpenAIResponsesCompactionResult, toCompactPayloadShape } from '../../src/openai-responses/compact.ts';
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

test('OpenAI Responses Compact normalizes typed result numbers and preserves opaque output numbers', () => {
  const text = '{"id":"c","object":"response.compaction","created_at":1e0,"output":[{"type":"future","vendor":2e0}],"usage":{"input_tokens":1e0,"output_tokens":2.0,"total_tokens":3.0,"input_tokens_details":{"cached_tokens":0.0,"cache_write_tokens":1e0},"output_tokens_details":{"reasoning_tokens":1e0,"vendor":2e0}}}';
  expect(decodeOpenAIResponsesCompactionResult(JSON.parse(text)).ok).toBe(true);
  const decoded = decodeOpenAIResponsesCompactionResult(parseJSONWithRawNumbers(text));
  if (!decoded.ok) throw decoded.error;
  expect(decoded.value).toMatchObject({
    created_at: 1,
    usage: {
      input_tokens: 1, output_tokens: 2, total_tokens: 3,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  });
  expect(JSON.stringify(decoded.value)).toContain('"output":[{"type":"future","vendor":2e0}]');
  expect(JSON.stringify(decoded.value)).toContain('"reasoning_tokens":1,"vendor":2e0');
});

test('toCompactPayloadShape preserves explicit null cache options from a canonical compact request', () => {
  const payload: Omit<CanonicalOpenAIResponsesCompactPayload, 'model'> = {
    input: [{ type: 'message', role: 'user', content: 'hello' }],
    prompt_cache_options: null,
    store: false,
  };
  assertEquals(toCompactPayloadShape(payload), {
    input: payload.input,
    prompt_cache_options: null,
  });
});
