import { expect, test } from 'vitest';

import { tokenUsageFromChatCompletionsUsage } from './usage.ts';
import { USAGE_BILLING } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

test('Chat usage maps disjoint input/cache/output counts and omits tier when service_tier is absent', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } },
      null,
    ),
    {
      input: 70,
      input_cache_read: 30,
      output: 20,
    },
  );
});

test('Chat usage reads DeepSeek prompt_cache_hit_tokens at the usage root', () => {
  // DeepSeek puts the hit count at the usage root (paired with miss) instead
  // of under prompt_tokens_details. The shared helper sniffs the variant and
  // lands it in cache_read, leaving miss on bare input.
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      // The non-standard hit/miss fields aren't on ChatCompletionsUsage; we
      // cast through to mirror what an actual DeepSeek response would carry.
      { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 } as never,
      null,
    ),
    {
      input: 72,
      input_cache_read: 128,
      output: 5,
    },
  );
});

test('Chat usage reads the flat top-level cached_tokens (Moonshot / Cohere v2 / Qwen Singapore legacy)', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53, cached_tokens: 32 } as never,
      null,
    ),
    {
      input: 18,
      input_cache_read: 32,
      output: 3,
    },
  );
});

test('Chat usage reads OpenRouter cache_write_tokens as the write counter', () => {
  // OpenRouter emits cache_write_tokens alongside cached_tokens under the
  // standard wrapper when it routes to Anthropic / explicit-Gemini / Alibaba.
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 50 } },
      null,
    ),
    {
      input: 20,
      input_cache_read: 30,
      input_cache_write: 50,
      output: 4,
    },
  );
});

test('Chat usage preserves translated 1-hour cache writes', () => {
  expect(tokenUsageFromChatCompletionsUsage({
    prompt_tokens: 20,
    completion_tokens: 2,
    total_tokens: 22,
    prompt_tokens_details: { cache_creation_input_tokens: 9 },
    [USAGE_BILLING]: { cacheWrite1hTokenCount: 5 },
  }, null)).toEqual({
    input: 11,
    input_cache_write: 4,
    input_cache_write_1h: 5,
    output: 2,
  });
});

test.each([
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 } },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: -1 } },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: 1.5 } },
])('Chat usage rejects malformed inclusive cache counts', usage => {
  expect(() => tokenUsageFromChatCompletionsUsage(usage, null)).toThrowError(RangeError);
});

test('Chat usage drops service_tier=default to no-tier', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'default',
    ),
    {
      input: 10,
      output: 2,
    },
  );
});

test('Chat usage forwards service_tier=priority verbatim', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'priority',
    ),
    {
      input: 10,
      output: 2,
      tier: 'priority',
    },
  );
});

test('Chat usage forwards service_tier=flex verbatim', () => {
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'flex',
    ),
    {
      input: 10,
      output: 2,
      tier: 'flex',
    },
  );
});

test('Chat usage forwards an unknown tier verbatim (forward-compat with a future wire value)', () => {
  // A future OpenAI value the SDK has not minted yet must reach the billing
  // record so the operator can backfill a per-tier pricing override for it
  // rather than have it silently fold into the base bucket.
  assertEquals(
    tokenUsageFromChatCompletionsUsage(
      { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      'super-priority',
    ),
    {
      input: 10,
      output: 2,
      tier: 'super-priority',
    },
  );
});
