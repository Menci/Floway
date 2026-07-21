import { expect, test } from 'vitest';

import { tokenUsageFromCompletionsUsage } from './usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('tokenUsageFromCompletionsUsage maps the OpenAI bare shape to bare input + output', () => {
  assertEquals(
    tokenUsageFromCompletionsUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, undefined),
    { input: 12, output: 3 },
  );
});

test('tokenUsageFromCompletionsUsage splits prompt_tokens into cache_read + bare input when prompt_tokens_details.cached_tokens is populated', () => {
  // vLLM, llama.cpp, Fireworks, OpenRouter, xAI Grok all populate this on
  // /v1/completions; the cache_read tokens come out of the bare input bucket
  // so the two input metrics stay disjoint.
  assertEquals(
    tokenUsageFromCompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
      undefined,
    ),
    { input: 20, input_cache_read: 80, output: 7 },
  );
});

test('tokenUsageFromCompletionsUsage reads DeepSeek prompt_cache_hit_tokens', () => {
  // DeepSeek exposes a non-OpenAI shape on /v1/chat/completions (it has no
  // /v1/completions of its own, but the helper symmetry matters): hit + miss
  // counters at the usage root, with `prompt_tokens` equal to `hit + miss`.
  assertEquals(
    tokenUsageFromCompletionsUsage(
      { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 },
      undefined,
    ),
    { input: 72, input_cache_read: 128, output: 5 },
  );
});

test('tokenUsageFromCompletionsUsage reads the flat top-level cached_tokens (Moonshot / Cohere v2 / Qwen Singapore legacy)', () => {
  assertEquals(
    tokenUsageFromCompletionsUsage(
      { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53, cached_tokens: 32 },
      undefined,
    ),
    { input: 18, input_cache_read: 32, output: 3 },
  );
});

test.each([
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: 50 } },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, cached_tokens: -1 },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_cache_hit_tokens: 1.5 },
])('tokenUsageFromCompletionsUsage rejects malformed inclusive cache counts', usage => {
  expect(() => tokenUsageFromCompletionsUsage(usage, null)).toThrowError(RangeError);
});

test('tokenUsageFromCompletionsUsage runs serviceTier through billableServiceTier', () => {
  // Non-base values pass through; default / standard fold to null so they
  // aggregate with rows that have no tier; null/undefined stays null.
  assertEquals(
    tokenUsageFromCompletionsUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'priority'),
    { input: 5, output: 2, tier: 'priority' },
  );
  assertEquals(
    tokenUsageFromCompletionsUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'default'),
    { input: 5, output: 2 },
  );
  assertEquals(
    tokenUsageFromCompletionsUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, null),
    { input: 5, output: 2 },
  );
});

test('tokenUsageFromCompletionsUsage returns null on malformed input', () => {
  assertEquals(tokenUsageFromCompletionsUsage(null, undefined), null);
  assertEquals(tokenUsageFromCompletionsUsage({}, undefined), null);
  assertEquals(tokenUsageFromCompletionsUsage({ prompt_tokens: 'no' }, undefined), null);
});
