import { test } from 'vitest';

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
  // so the two input dimensions stay disjoint.
  assertEquals(
    tokenUsageFromCompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
      undefined,
    ),
    { input: 20, input_cache_read: 80, output: 7 },
  );
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
