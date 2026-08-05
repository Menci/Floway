import { test } from 'vitest';

import { openAICacheTokensFromUsage, recordUsage, tokenUsageFromImagesBody } from '../../../../src/data-plane/shared/telemetry/usage.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { basePricing } from '@floway-dev/protocols/common';
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

test.each([
  {
    name: 'zero counts',
    usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0, input_tokens_details: { text_tokens: 0, image_tokens: 0 } },
    expected: {},
  },
  {
    name: 'split input modalities and image output',
    usage: { total_tokens: 19, input_tokens: 12, output_tokens: 7, input_tokens_details: { text_tokens: 5, image_tokens: 7 } },
    expected: { input: 5, input_image: 7, output_image: 7 },
  },
  {
    name: 'maximum safe input count',
    usage: {
      total_tokens: Number.MAX_SAFE_INTEGER,
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 0,
      input_tokens_details: { text_tokens: Number.MAX_SAFE_INTEGER, image_tokens: 0 },
    },
    expected: { input: Number.MAX_SAFE_INTEGER },
  },
  {
    name: 'maximum safe output count',
    usage: {
      total_tokens: Number.MAX_SAFE_INTEGER,
      input_tokens: 0,
      output_tokens: Number.MAX_SAFE_INTEGER,
      input_tokens_details: { text_tokens: 0, image_tokens: 0 },
    },
    expected: { output_image: Number.MAX_SAFE_INTEGER },
  },
])('tokenUsageFromImagesBody accepts $name', ({ usage, expected }) => {
  assertEquals(tokenUsageFromImagesBody({ usage }), expected);
});

test.each([
  { name: 'an array response', body: [] },
  { name: 'missing usage', body: {} },
  { name: 'array usage', body: { usage: [] } },
  {
    name: 'a missing required aggregate',
    body: { usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 } } },
  },
  {
    name: 'array input details',
    body: { usage: { total_tokens: 2, input_tokens: 1, output_tokens: 1, input_tokens_details: [] } },
  },
  {
    name: 'a missing required input detail',
    body: { usage: { total_tokens: 2, input_tokens: 1, output_tokens: 1, input_tokens_details: { text_tokens: 1 } } },
  },
  {
    name: 'negative counts',
    body: { usage: { total_tokens: 0, input_tokens: -1, output_tokens: 1, input_tokens_details: { text_tokens: -1, image_tokens: 0 } } },
  },
  {
    name: 'fractional counts',
    body: { usage: { total_tokens: 2, input_tokens: 1.5, output_tokens: 0.5, input_tokens_details: { text_tokens: 1, image_tokens: 0.5 } } },
  },
  {
    name: 'unsafe counts',
    body: {
      usage: {
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
        input_tokens_details: { text_tokens: Number.MAX_SAFE_INTEGER, image_tokens: 0 },
      },
    },
  },
  {
    name: 'an inconsistent input detail sum',
    body: { usage: { total_tokens: 3, input_tokens: 2, output_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 } } },
  },
  {
    name: 'an inconsistent total',
    body: { usage: { total_tokens: 4, input_tokens: 2, output_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 1 } } },
  },
])('tokenUsageFromImagesBody rejects $name', ({ body }) => {
  assertEquals(tokenUsageFromImagesBody(body), null);
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
