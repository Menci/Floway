import { test } from 'vitest';

import { openAICacheTokensFromUsage } from './usage.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('OpenAI canonical shape — prompt_tokens_details.cached_tokens lands in cacheRead', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } }),
    { cacheRead: 80, cacheWrite: 0 },
  );
});

test('DeepSeek shape — prompt_cache_hit_tokens at usage root lands in cacheRead', () => {
  // DeepSeek emits `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens` at
  // the usage root; prompt_tokens is hit + miss.
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 200, completion_tokens: 5, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 }),
    { cacheRead: 128, cacheWrite: 0 },
  );
});

test('Flat shape — top-level cached_tokens (Moonshot / Cohere v2 / Qwen Singapore legacy)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 50, completion_tokens: 3, cached_tokens: 32 }),
    { cacheRead: 32, cacheWrite: 0 },
  );
});

test('OpenAI canonical wins when both nested and flat are present (the wrapped form is authoritative)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 64 }, cached_tokens: 999 }),
    { cacheRead: 64, cacheWrite: 0 },
  );
});

test('Cache-write — Anthropic-style cache_creation_input_tokens under the wrapper', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 50 } }),
    { cacheRead: 30, cacheWrite: 50 },
  );
});

test('Cache-write — OpenRouter cache_write_tokens under the wrapper', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 50 } }),
    { cacheRead: 30, cacheWrite: 50 },
  );
});

test('cache_creation_input_tokens wins over cache_write_tokens when both are present (Anthropic-native name is authoritative)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cache_creation_input_tokens: 20, cache_write_tokens: 50 } }),
    { cacheRead: 0, cacheWrite: 20 },
  );
});

test('Zero on missing / malformed / fields-absent usage blocks', () => {
  assertEquals(openAICacheTokensFromUsage(null), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage(undefined), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage('not an object'), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage({}), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2 }), { cacheRead: 0, cacheWrite: 0 });
  // Gemini OpenAI-compat emits `prompt_tokens_details: null` on cache miss
  // (not an empty object); the optional chain has to absorb that.
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: null }), { cacheRead: 0, cacheWrite: 0 });
  // Non-numeric noise falls through.
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens_details: { cached_tokens: 'no' } }), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage({ prompt_cache_hit_tokens: null }), { cacheRead: 0, cacheWrite: 0 });
});

test('Zero is a valid count, not a missing signal', () => {
  // vLLM with --enable-prompt-tokens-details emits cached_tokens: 0 on a cold
  // request after PR #44383; an honest zero must not fall through to the
  // next candidate.
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 999 }),
    { cacheRead: 0, cacheWrite: 0 },
  );
});
