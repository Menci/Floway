import { expect, test } from 'vitest';

import { tokenUsageFromOpenAICompletionsUsage } from '../../../src/data-plane/openai-completions/usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('tokenUsageFromOpenAICompletionsUsage splits prompt_tokens into cache_read + bare input when prompt_tokens_details.cached_tokens is populated', () => {
  // vLLM, llama.cpp, Fireworks, OpenRouter, xAI Grok all populate this on
  // /v1/completions; the cache_read tokens come out of the bare input bucket
  // so the two input metrics stay disjoint.
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
      undefined, false, 'up/model',
    ),
    { input: 20, input_cache_read: 80, output: 7 },
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
    { input: 72, input_cache_read: 128, output: 5 },
  );
});

test.each([
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_tokens_details: { cached_tokens: 50 } },
  { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41, prompt_cache_hit_tokens: 1.5 },
])('tokenUsageFromOpenAICompletionsUsage rejects malformed inclusive cache counts', usage => {
  expect(() => tokenUsageFromOpenAICompletionsUsage(usage, null, false, 'up/model')).toThrowError(RangeError);
});

test('tokenUsageFromOpenAICompletionsUsage folds the cache counts back in on the totals alone', () => {
  assertEquals(
    tokenUsageFromOpenAICompletionsUsage(
      { prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164, prompt_tokens_details: { cached_tokens: 13312 } },
      undefined, false, 'up/model',
    ),
    { input: 479, input_cache_read: 13312, output: 373 },
  );
});
