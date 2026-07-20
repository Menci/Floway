import { test } from 'vitest';

import { settleUsageMeasurement } from './settle.ts';
import { audioTranscriptionUsageMeasurement, openAICacheTokensFromUsage, recordUsage } from './usage.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { basePricing } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';

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

test('recordUsage persists caller-supplied quantities and units with resolved prices', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await recordUsage(
    'key-a',
    {
      model: 'transcribe-model',
      upstream: 'upstream-a',
      modelKey: 'transcribe-model',
      pricing: basePricing({ input: 'minutes' }, { input: 0.6 }),
    },
    { input: 90 },
    { input: 'minutes' },
    {},
  );

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].dimensions, [{ dimension: 'input', unit: 'minutes', quantity: 90, unitPrice: 0.6 }]);
});

test('recordUsage rejects a measured unit that disagrees with model pricing', async () => {
  initRepo(new InMemoryRepo());

  await assertRejects(
    () => recordUsage(
      'key-a',
      {
        model: 'rerank-model',
        upstream: 'upstream-a',
        modelKey: 'rerank-model',
        pricing: basePricing({ input: 'searches_1k' }, { input: 2 }),
      },
      { input: 1 },
      { input: 'tokens_1m' },
      {},
    ),
    Error,
    'measured in tokens_1m but priced in searches_1k',
  );
});

test('audio transcription usage preserves duration seconds with a minutes denominator', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'duration', seconds: 91 },
    duration: 91.8,
  }), {
    quantities: { input: 91 },
    units: { input: 'minutes' },
    pricingFacts: {},
    dumpTokenUsage: null,
  });
});

test('audio transcription usage maps explicit token counts without inferring from totals', () => {
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 59 },
  }), {
    quantities: { input: 14, output: 45 },
    units: { input: 'tokens_1m', output: 'tokens_1m' },
    pricingFacts: { serviceTier: undefined, inputTokens: 14 },
    dumpTokenUsage: { input: 14, output: 45 },
  });
  assertEquals(audioTranscriptionUsageMeasurement({
    usage: { type: 'tokens', total_tokens: 59 },
  }).quantities, {});
});

test('audio transcription usage without a recognized metric is request-only', () => {
  for (const body of [
    { duration: 10 },
    { usage: { seconds: 10 } },
    { usage: { type: 'future_metric', samples: 10 } },
  ]) {
    assertEquals(audioTranscriptionUsageMeasurement(body), {
      quantities: {}, units: {}, pricingFacts: {}, dumpTokenUsage: null,
    });
  }
});

test('audio transcription usage rejects malformed declared metrics', () => {
  for (const [body, message] of [
    [{ usage: null }, 'usage must be an object'],
    [{ usage: 'tokens' }, 'usage must be an object'],
    [{ usage: { type: 'duration' } }, 'duration usage.seconds'],
    [{ usage: { type: 'duration', seconds: '10' } }, 'duration usage.seconds'],
    [{ usage: { type: 'tokens', input_tokens: -1 } }, 'token usage.input_tokens'],
    [{ usage: { type: 'tokens', output_tokens: Number.NaN } }, 'token usage.output_tokens'],
    [{ usage: { type: 'tokens', total_tokens: '59' } }, 'token usage.total_tokens'],
  ] as const) {
    assertThrows(() => audioTranscriptionUsageMeasurement(body), Error, message);
  }
});

test('measurement settling rejects a token-denominated output without its quantity', () => {
  const ctx: GatewayCtx = {
    apiKeyId: 'key-a',
    upstreamIds: null,
    wantsStream: false,
    backgroundScheduler: () => {},
    attempt: { upstreamCallStartedAt: null, firstOutputTokenAt: null, telemetry: undefined },
    runtimeLocation: 'TEST',
    dump: null,
    responseHeaders: new Headers(),
  };
  assertThrows(
    () => settleUsageMeasurement(
      ctx,
      undefined,
      { model: 'audio-model', upstream: 'upstream-a', modelKey: 'audio-model', pricing: null },
      { quantities: {}, units: { output: 'tokens_1m' }, pricingFacts: {}, dumpTokenUsage: null },
      false,
    ),
    Error,
    'requires an output quantity',
  );
});
