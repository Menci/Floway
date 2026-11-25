import { expect, test } from 'vitest';

import { decodeOpenAIResponsesCompactionResult, toCompactPayloadShape } from '../../src/openai-responses/compact.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('toCompactPayloadShape preserves compact cache controls', () => {
  assertEquals(toCompactPayloadShape({
    model: 'gpt-test',
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

const compact = {
  id: 'resp_compact_1',
  object: 'response.compaction',
  created_at: 4,
  output: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }], extension: { trace: 'kept' } },
    { type: 'context_compaction', id: 'cmp_1', encrypted_content: 'opaque', metadata: { revision: 1 } },
    { type: 'future_item', provider: { kept: true } },
  ],
  usage: {
    input_tokens: 4, output_tokens: 2, total_tokens: 6,
    input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  extension: true,
};

test('decodes compaction results without changing the retained items or extension fields', () => {
  const parsed = decodeOpenAIResponsesCompactionResult(compact);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toBe(compact);
  const sparse = { id: 'compaction', object: 'response.compaction', output: [] };
  expect(decodeOpenAIResponsesCompactionResult(sparse)).toEqual({ ok: true, value: sparse });
});

test('preserves replayed messages that omit image detail or carry Codex audio references', () => {
  const body = {
    ...compact,
    output: [{
      type: 'message', role: 'user', content: [
        { type: 'output_text', text: 'replayed text' },
        { type: 'input_image', image_url: 'https://example.test/image.png' },
        { type: 'input_audio', file_id: 'file_audio' },
      ],
    }],
  };
  expect(decodeOpenAIResponsesCompactionResult(body)).toEqual({ ok: true, value: body });
});

test.each([
  ['id', { id: 8 }],
  ['output array', { output: {} }],
  ['stored item', { output: [null] }],
  ['message', { output: [{ type: 'message', role: 'user' }] }],
  ['message content', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'input_text', text: ['no'] }] }] }],
  ['reasoning summary', { output: [{ type: 'reasoning', summary: [{ type: 'summary_text' }] }] }],
  ['function arguments', { output: [{ type: 'function_call', call_id: 'call', name: 'tool' }] }],
  ['function output', { output: [{ type: 'function_call_output', call_id: 'call', output: {} }] }],
  ['compaction bytes', { output: [{ type: 'context_compaction', encrypted_content: {} }] }],
  ['creation time', { created_at: '4' }],
  ['usage', { usage: { ...compact.usage, total_tokens: '6' } }],
  ['usage details', { usage: { ...compact.usage, output_tokens_details: { reasoning_tokens: '0' } } }],
])('rejects malformed compaction %s', (_field, patch) => {
  expect(decodeOpenAIResponsesCompactionResult({ ...compact, ...patch })).toMatchObject({ ok: false, error: expect.any(Error) });
});
