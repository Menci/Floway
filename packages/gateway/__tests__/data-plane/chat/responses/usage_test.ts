import { test } from 'vitest';

import { billableUsageFromResponsesResult } from '../../../../src/data-plane/chat/responses/usage.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

const result = (usage: ResponsesResult['usage'], serviceTier?: string): ResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'm', output: [], status: 'completed',
  error: null, incomplete_details: null,
  ...(usage !== undefined ? { usage } : {}),
  ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
});

test('Responses billable usage splits the inclusive input total into disjoint buckets', () => {
  assertEquals(billableUsageFromResponsesResult(result({
    input_tokens: 100, output_tokens: 8, total_tokens: 108,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
  })), { input: 45, cacheRead: 30, cacheWrite: 25, cacheWrite1h: 0, output: 8 });
});

test('Responses billable usage is absent when the upstream reported none', () => {
  assertEquals(billableUsageFromResponsesResult(result(undefined)), null);
});

test('Responses billable usage forwards a served tier and drops the default', () => {
  assertEquals(billableUsageFromResponsesResult(result({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, 'priority'))?.tier, 'priority');
  assertEquals(billableUsageFromResponsesResult(result({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, 'default'))?.tier, undefined);
});
