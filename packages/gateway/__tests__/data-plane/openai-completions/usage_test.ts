import { expect, test } from 'vitest';

import { tokenUsageFromOpenAICompletionsUsage } from '../../../src/data-plane/openai-completions/usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('tokenUsageFromOpenAICompletionsUsage maps the OpenAI bare shape to bare input + output', () => {
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, undefined, false, 'up/model'),
    { input: 12, input_cache_read: 0, input_cache_write: 0, output: 3, tier: null },
  );
});

test('tokenUsageFromOpenAICompletionsUsage splits prompt_tokens into cache_read + bare input when prompt_tokens_details.cached_tokens is populated', () => {
  // vLLM, llama.cpp, Fireworks, OpenRouter, xAI Grok all populate this on
  // /v1/completions; the cache_read tokens come out of the bare input bucket
  // so the two input metrics stay disjoint.
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
      undefined, false, 'up/model',
    ),
    { input: 20, input_cache_read: 80, input_cache_write: 0, output: 7, tier: null },
  );
});

test('tokenUsageFromOpenAICompletionsUsage reads DeepSeek prompt_cache_hit_tokens', () => {
  // DeepSeek exposes a non-OpenAI shape on /v1/chat/completions (it has no
  // /v1/completions of its own, but the helper symmetry matters): hit + miss
  // counters at the usage root, with `prompt_tokens` equal to `hit + miss`.
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 },
      undefined, false, 'up/model',
    ),
    { input: 72, input_cache_read: 128, input_cache_write: 0, output: 5, tier: null },
  );
});

test('tokenUsageFromOpenAICompletionsUsage reads the flat top-level cached_tokens (Moonshot / Cohere v2 / Qwen Singapore legacy)', () => {
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53, cached_tokens: 32 },
      undefined, false, 'up/model',
    ),
    { input: 18, input_cache_read: 32, input_cache_write: 0, output: 3, tier: null },
  );
});

test.each([
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: 50 } },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, cached_tokens: -1 },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_cache_hit_tokens: 1.5 },
])('tokenUsageFromOpenAICompletionsUsage rejects malformed inclusive cache counts', usage => {
  expect(() => tokenUsageFromOpenAICompletionsUsage(usage, null, false, 'up/model')).toThrowError(RangeError);
});

test('tokenUsageFromOpenAICompletionsUsage names the flag when the cache counts underflow with no verdict', () => {
  expect(() => tokenUsageFromOpenAICompletionsUsage(
    { prompt_tokens: 479, completion_tokens: 373, prompt_tokens_details: { cached_tokens: 13312 } },
    null, false, 'up/model',
  )).toThrowError(/enable usage-exclusive-cached-tokens/);
});

test('tokenUsageFromOpenAICompletionsUsage rejects a flag the totals contradict', () => {
  expect(() => tokenUsageFromOpenAICompletionsUsage(
    { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 } },
    null, true, 'up/model',
  )).toThrowError(/usage-exclusive-cached-tokens is enabled/);
});

test('tokenUsageFromOpenAICompletionsUsage runs serviceTier through billableServiceTier', () => {
  // Non-base values pass through; default / standard fold to null so they
  // aggregate with rows that have no tier; null/undefined stays null.
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'priority', false, 'up/model'),
    { input: 5, input_cache_read: 0, input_cache_write: 0, output: 2, tier: 'priority' },
  );
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'default', false, 'up/model'),
    { input: 5, input_cache_read: 0, input_cache_write: 0, output: 2, tier: null },
  );
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, null, false, 'up/model'),
    { input: 5, input_cache_read: 0, input_cache_write: 0, output: 2, tier: null },
  );
});

test('tokenUsageFromOpenAICompletionsUsage folds the cache counts back in on the totals alone', () => {
  // The same accounting the chat targets normalize on the usage chunk: this
  // endpoint runs no chat rules, so the fold happens on the billing read.
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164, prompt_tokens_details: { cached_tokens: 13312 } },
      undefined, false, 'up/model',
    ),
    { input: 479, input_cache_read: 13312, input_cache_write: 0, output: 373, tier: null },
  );
});

test('tokenUsageFromOpenAICompletionsUsage folds on the flag when the totals witness nothing', () => {
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 479, completion_tokens: 373, prompt_tokens_details: { cached_tokens: 13312 } },
      undefined, true, 'up/model',
    ),
    { input: 479, input_cache_read: 13312, input_cache_write: 0, output: 373, tier: null },
  );
});

test('tokenUsageFromOpenAICompletionsUsage returns null on malformed input', () => {
  assertEquals(tokenUsageFromOpenAICompletionsUsage(null, undefined, false, 'up/model'), null);
  assertEquals(tokenUsageFromOpenAICompletionsUsage({}, undefined, false, 'up/model'), null);
  assertEquals(tokenUsageFromOpenAICompletionsUsage({ prompt_tokens: 'no' }, undefined, false, 'up/model'), null);
});

test('tokenUsageFromOpenAICompletionsUsage retains a measured zero', () => {
  expect(tokenUsageFromOpenAICompletionsUsage({ prompt_tokens: 0, completion_tokens: 0 }, null, false, 'up/model')).toEqual({
    input: 0, input_cache_read: 0, input_cache_write: 0, output: 0, tier: null,
  });
});
