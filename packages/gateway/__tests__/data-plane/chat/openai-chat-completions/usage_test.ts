import { expect, test } from 'vitest';

import { billableUsageFromOpenAIChatCompletionsUsage } from '../../../../src/data-plane/chat/openai-chat-completions/usage.ts';

test('Chat billable usage splits the inclusive prompt total into disjoint buckets', () => {
  expect(billableUsageFromOpenAIChatCompletionsUsage({
    prompt_tokens: 100,
    completion_tokens: 8,
    total_tokens: 108,
    prompt_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 25 },
  }, null)).toEqual({ input: 45, cacheRead: 30, cacheWrite: 25, cacheWrite1h: 0, output: 8 });
});

test('Chat billable usage forwards a served tier and drops the default', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  expect(billableUsageFromOpenAIChatCompletionsUsage(usage, 'priority').tier).toBe('priority');
  expect(billableUsageFromOpenAIChatCompletionsUsage(usage, 'flex').tier).toBe('flex');
  expect(billableUsageFromOpenAIChatCompletionsUsage(usage, 'default').tier).toBeUndefined();
  expect(billableUsageFromOpenAIChatCompletionsUsage(usage, undefined).tier).toBeUndefined();
});

test('Chat billable usage reports no cache-write TTL split, which the protocol cannot express', () => {
  expect(billableUsageFromOpenAIChatCompletionsUsage({
    prompt_tokens: 20, completion_tokens: 2, total_tokens: 22,
    prompt_tokens_details: { cache_write_tokens: 9 },
  }, null).cacheWrite1h).toBe(0);
});
