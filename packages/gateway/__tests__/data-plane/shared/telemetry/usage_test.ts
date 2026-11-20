import { test } from 'vitest';

import { openAICacheTokensFromUsage, recordUsage } from '../../../../src/data-plane/shared/telemetry/usage.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

test('Flat shape — top-level cached_tokens (Moonshot / Cohere v2 / Qwen Singapore legacy)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 50, completion_tokens: 3, cached_tokens: 32 }),
    { cacheRead: 32, cacheWrite: 0 },
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
  // Gemini OpenAI-compat emits `prompt_tokens_details: null` on cache miss
  // (not an empty object); the optional chain has to absorb that.
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: null }), { cacheRead: 0, cacheWrite: 0 });
  // Non-numeric noise falls through.
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens_details: { cached_tokens: 'no' } }), { cacheRead: 0, cacheWrite: 0 });
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

test('recordUsage prices audio duration and token metrics together', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await recordUsage(
    'key-a',
    {
      model: 'composite-audio-model',
      upstream: 'upstream-a',
      modelKey: 'composite-audio-model',
      pricing: basePricing({ input_audio_seconds: '0.0001', input_audio_tokens: '0.000005' }),
    },
    { input_audio_seconds: '90.5', input_audio_tokens: '2400' },
    { inputTokens: 2400 },
  );

  const [row] = await repo.usage.listAll();
  assertEquals(row.metrics, [
    { metric: 'input_audio_tokens', quantity: '2400', unitPrice: '0.000005' },
    { metric: 'input_audio_seconds', quantity: '90.5', unitPrice: '0.0001' },
  ]);
});
