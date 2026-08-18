import { test } from 'vitest';

import { billableUsageFromOpenAIResponsesResult } from '../../../../src/data-plane/chat/openai-responses/usage.ts';
import type { OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const result = (usage: OpenAIResponsesResult['usage'], serviceTier?: string): OpenAIResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'm', output: [], status: 'completed',
  error: null, incomplete_details: null,
  ...(usage !== undefined ? { usage } : {}),
  ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
});

test('OpenAI Responses billable usage splits the inclusive input total into disjoint buckets', () => {
  assertEquals(billableUsageFromOpenAIResponsesResult(result({
    input_tokens: 100, output_tokens: 8, total_tokens: 108,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
  })), { input: 45, cacheRead: 30, cacheWrite: 25, cacheWrite1h: 0, output: 8 });
});

test('OpenAI Responses billable usage is absent when the upstream reported none', () => {
  assertEquals(billableUsageFromOpenAIResponsesResult(result(undefined)), null);
});

test('OpenAI Responses billable usage forwards a served tier and drops the default', () => {
  assertEquals(billableUsageFromOpenAIResponsesResult(result({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, 'priority'))?.tier, 'priority');
  assertEquals(billableUsageFromOpenAIResponsesResult(result({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, 'default'))?.tier, undefined);
});
