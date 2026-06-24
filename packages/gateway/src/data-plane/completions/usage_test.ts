import { test } from 'vitest';

import { completionsUsageFromStreamEvent, tokenUsageFromCompletionsUsage } from './usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('tokenUsageFromCompletionsUsage maps the OpenAI bare shape to bare input + output', () => {
  assertEquals(
    tokenUsageFromCompletionsUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
    { input: 12, output: 3 },
  );
});

test('tokenUsageFromCompletionsUsage splits prompt_tokens into cache_read + bare input when the upstream populates prompt_tokens_details.cached_tokens', () => {
  // vLLM, llama.cpp, Fireworks, OpenRouter, xAI Grok all populate this on
  // /v1/completions; the cache_read tokens come out of the bare input bucket
  // so the three dimensions stay disjoint.
  assertEquals(
    tokenUsageFromCompletionsUsage({
      prompt_tokens: 100,
      completion_tokens: 7,
      total_tokens: 107,
      prompt_tokens_details: { cached_tokens: 80 },
    }),
    { input: 20, input_cache_read: 80, output: 7 },
  );
});

test('tokenUsageFromCompletionsUsage splits prompt_tokens into cache_write + bare input when an upstream bridges Anthropic-shape cache_creation_input_tokens', () => {
  assertEquals(
    tokenUsageFromCompletionsUsage({
      prompt_tokens: 50,
      completion_tokens: 9,
      total_tokens: 59,
      prompt_tokens_details: { cache_creation_input_tokens: 30 },
    }),
    { input: 20, input_cache_write: 30, output: 9 },
  );
});

test('tokenUsageFromCompletionsUsage returns null on malformed input', () => {
  assertEquals(tokenUsageFromCompletionsUsage(null), null);
  assertEquals(tokenUsageFromCompletionsUsage('string'), null);
  assertEquals(tokenUsageFromCompletionsUsage({}), null);
  assertEquals(tokenUsageFromCompletionsUsage({ prompt_tokens: 'no' }), null);
});

test('completionsUsageFromStreamEvent preserves the cache split into the carried CompletionsUsage', () => {
  const event = {
    id: 'cmpl_x',
    object: 'text_completion',
    created: 1,
    model: 'm',
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
  };
  assertEquals(completionsUsageFromStreamEvent(event), {
    prompt_tokens: 100,
    completion_tokens: 7,
    total_tokens: 107,
    prompt_tokens_details: { cached_tokens: 80 },
  });
});

test('completionsUsageFromStreamEvent omits prompt_tokens_details when no recognized split fields are present', () => {
  const event = {
    id: 'cmpl_x',
    object: 'text_completion',
    created: 1,
    model: 'm',
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
  };
  assertEquals(completionsUsageFromStreamEvent(event), {
    prompt_tokens: 5,
    completion_tokens: 4,
    total_tokens: 9,
  });
});
