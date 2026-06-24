import { test } from 'vitest';

import { billingFromCompletionsUsageAndTier, tokenUsageFromCompletionsBody } from './usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('tokenUsageFromCompletionsBody maps the OpenAI bare shape to bare input + output', () => {
  assertEquals(
    tokenUsageFromCompletionsBody({ usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    { input: 12, output: 3 },
  );
});

test('tokenUsageFromCompletionsBody splits prompt_tokens into cache_read + bare input when the upstream populates prompt_tokens_details.cached_tokens', () => {
  // vLLM, llama.cpp, Fireworks, OpenRouter, xAI Grok all populate this on
  // /v1/completions; the cache_read tokens come out of the bare input bucket
  // so the two input dimensions stay disjoint.
  assertEquals(
    tokenUsageFromCompletionsBody({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 7,
        total_tokens: 107,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }),
    { input: 20, input_cache_read: 80, output: 7 },
  );
});

test('tokenUsageFromCompletionsBody carries service_tier from the response root through billableServiceTier', () => {
  // vLLM emits `service_tier` on the /v1/completions response root
  // (observed null in the wild; populated when the upstream applies
  // priority/flex/etc tiering). Non-base values pass through; default /
  // standard fold to null so they aggregate with rows that have no tier.
  assertEquals(
    tokenUsageFromCompletionsBody({
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      service_tier: 'priority',
    }),
    { input: 5, output: 2, tier: 'priority' },
  );
  assertEquals(
    tokenUsageFromCompletionsBody({
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      service_tier: 'default',
    }),
    { input: 5, output: 2 },
  );
  assertEquals(
    tokenUsageFromCompletionsBody({
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      service_tier: null,
    }),
    { input: 5, output: 2 },
  );
});

test('tokenUsageFromCompletionsBody returns null on malformed input', () => {
  assertEquals(tokenUsageFromCompletionsBody(null), null);
  assertEquals(tokenUsageFromCompletionsBody('string'), null);
  assertEquals(tokenUsageFromCompletionsBody({}), null);
  assertEquals(tokenUsageFromCompletionsBody({ usage: { prompt_tokens: 'no' } }), null);
});

test('billingFromCompletionsUsageAndTier combines usage + tier collected from separate stream-event sources', () => {
  // The streaming closure tracks the usage block (from the usage-only
  // chunk) and the service_tier (from any chunk root the upstream
  // chooses) separately, then merges them here at settle time.
  assertEquals(
    billingFromCompletionsUsageAndTier(
      { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } },
      'priority',
    ),
    { input: 20, input_cache_read: 80, output: 7, tier: 'priority' },
  );
});

test('billingFromCompletionsUsageAndTier accepts an undefined tier (the no-tier-seen path)', () => {
  assertEquals(
    billingFromCompletionsUsageAndTier(
      { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      undefined,
    ),
    { input: 5, output: 2 },
  );
});

test('billingFromCompletionsUsageAndTier returns null when the usage block is missing or malformed', () => {
  assertEquals(billingFromCompletionsUsageAndTier(null, 'priority'), null);
  assertEquals(billingFromCompletionsUsageAndTier({}, 'priority'), null);
  assertEquals(billingFromCompletionsUsageAndTier({ prompt_tokens: 'no' }, 'priority'), null);
});
