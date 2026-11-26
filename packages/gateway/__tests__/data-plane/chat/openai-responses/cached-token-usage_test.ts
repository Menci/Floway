import { expect, test } from 'vitest';

import { normalizeOpenAIResponsesResourceUsage } from '../../../../src/data-plane/chat/openai-responses/cached-token-usage.ts';
import { openAIResponsesProtocolError } from '../../../../src/data-plane/chat/openai-responses/stream-error.ts';
import { openAIResponsesUsage } from '../../../../src/data-plane/chat/openai-responses/usage.ts';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';

test('wire totals identify exclusive read and write counts before usage is billed', () => {
  const usage = {
    input_tokens: 10, output_tokens: 20, total_tokens: 37,
    input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
  };
  const failed: OpenAIResponsesResultEx = {
    id: 'response', object: 'response', model: 'model', output: [], status: 'failed',
    error: { code: 'server_error', message: 'generating failed' }, incomplete_details: null, usage,
  };
  const normalized = normalizeOpenAIResponsesResourceUsage(failed, false, 'upstream/model');
  expect(normalized.usage?.input_tokens).toBe(17);
  expect(failed.usage).toBe(usage);
  expect(failed.usage?.input_tokens).toBe(10);

  const reader = openAIResponsesUsage();
  const result = reader.error?.(openAIResponsesProtocolError(new Error('generating failed'), {
    failed: { type: 'response.failed', response: normalized },
  }));
  expect(result?.[0]?.dumpTokenUsage).toMatchObject({ input: 10, input_cache_read: 5, input_cache_write: 2, output: 20 });
});
