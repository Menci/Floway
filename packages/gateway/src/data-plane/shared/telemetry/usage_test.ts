import { test } from 'vitest';

import { audioTranscriptionUsageMeasurement, openAICacheTokensFromUsage, recordUsage } from './usage.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

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

test('recordUsage persists caller-supplied metrics with resolved prices', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await recordUsage(
    'key-a',
    {
      model: 'metered-model',
      upstream: 'upstream-a',
      modelKey: 'metered-model',
      pricing: basePricing({ input_tokens: '0.6' }),
    },
    { input_tokens: '90' },
    {},
  );

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, [{ metric: 'input_tokens', quantity: '90', unitPrice: '0.6' }]);
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

test('audio transcription usage preserves duration seconds as a base-unit metric', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'duration', seconds: 91 },
    duration: 91.8,
  }), {
    quantities: { input_audio_seconds: '91' },
    pricingFacts: {},
    dumpTokenUsage: null,
  });
});

test('audio transcription usage maps text and audio input token details to disjoint metrics', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: {
      type: 'tokens',
      input_tokens: 14,
      input_token_details: { text_tokens: 4, audio_tokens: 10 },
      output_tokens: 45,
      total_tokens: 59,
    },
  }), {
    quantities: { input_tokens: '4', input_audio_tokens: '10', output_tokens: '45' },
    pricingFacts: { inputTokens: 14 },
    dumpTokenUsage: { input: 14, output: 45 },
  });
});

test('audio transcription usage keeps aggregate input tokens general when details are absent', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 59 },
  }).quantities, { input_tokens: '14', output_tokens: '45' });
});

test('audio transcription usage without a recognized metric is request-only', () => {
  for (const body of [
    { duration: 10 },
    { usage: { seconds: 10 } },
    { usage: { type: 'future_metric', samples: 10 } },
  ]) {
    assertEquals(audioTranscriptionUsageMeasurement(body), {
      quantities: {}, pricingFacts: {}, dumpTokenUsage: null,
    });
  }
});

test('audio transcription usage rejects malformed declared metrics', () => {
  for (const [body, message] of [
    [{ usage: null }, 'usage must be an object'],
    [{ usage: 'tokens' }, 'usage must be an object'],
    [{ usage: { type: 'duration' } }, 'duration usage.seconds'],
    [{ usage: { type: 'duration', seconds: '10' } }, 'duration usage.seconds'],
    [{ usage: { type: 'tokens', input_tokens: -1, output_tokens: 45, total_tokens: 44 } }, 'token usage.input_tokens'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: Number.NaN, total_tokens: 59 } }, 'token usage.output_tokens'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: '59' } }, 'token usage.total_tokens'],
    [{ usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 58 } }, 'total_tokens must equal'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: null, output_tokens: 45, total_tokens: 59 } }, 'input_token_details must be an object'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4 }, output_tokens: 45, total_tokens: 59 } }, 'audio_tokens must be'],
    [{ usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4, audio_tokens: 9 }, output_tokens: 45, total_tokens: 59 } }, 'input_token_details must sum'],
  ] as const) {
    assertThrows(() => audioTranscriptionUsageMeasurement(body), Error, message);
  }
});
