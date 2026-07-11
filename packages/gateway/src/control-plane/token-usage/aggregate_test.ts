import { test } from 'vitest';

import { aggregateUsageForDisplay } from './aggregate.ts';
import type { UsageRecord } from '../../repo/types.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { assertAlmostEquals, assertEquals } from '@floway-dev/test-utils';

const opus47Pricing: ModelPricing = { input: 5, output: 25, input_cache_read: 0.5, input_cache_write: 6.25 };
const gpt54Pricing: ModelPricing = { input: 2.5, output: 15, input_cache_read: 0.25 };

const baseRecord = (overrides: Partial<UsageRecord>): UsageRecord => ({
  keyId: 'key-1',
  hour: '2026-05-01T00',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot',
  modelKey: 'claude-opus-4-7',
  tier: null,
  inputAboveTokens: null,
  requests: 1,
  tokens: { input: 100, output: 50 },
  cost: opus47Pricing,
  ...overrides,
});

test('aggregateUsageForDisplay groups variants that share public model id', () => {
  const records: UsageRecord[] = [
    baseRecord({ requests: 2, tokens: { input: 100, output: 50 } }),
    baseRecord({ modelKey: 'claude-opus-4-7-xhigh', requests: 3, tokens: { input: 200, output: 50 } }),
    baseRecord({ modelKey: 'claude-opus-4-7-1m-internal', requests: 1, tokens: { input: 50, output: 50 } }),
  ];

  const out = aggregateUsageForDisplay(records);
  assertEquals(out.length, 1);
  assertEquals(out[0].model, 'claude-opus-4-7');
  assertEquals(out[0].requests, 6);
  assertEquals(out[0].tokens.input, 350);
  assertEquals('upstream' in out[0], false);
  assertEquals('modelKey' in out[0], false);
});

test('aggregateUsageForDisplay applies cost from each record snapshot', () => {
  const records: UsageRecord[] = [baseRecord({ modelKey: 'claude-opus-4-7-xhigh', tokens: { input: 1_000_000, output: 50 } })];
  const out = aggregateUsageForDisplay(records);
  // 1M input * $5/MTok = $5; output 50 tokens * $25/MTok ≈ $0.00125. total ≈ 5.00125.
  assertAlmostEquals(out[0].cost, 5 + (50 * 25) / 1e6, 1e-9);
});

test('aggregateUsageForDisplay sums cost across grouped raw records', () => {
  const records: UsageRecord[] = [
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', cost: gpt54Pricing, tokens: { input: 1_000_000 } }),
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', cost: gpt54Pricing, tokens: { input: 1_000_000 } }),
  ];
  const out = aggregateUsageForDisplay(records);
  assertEquals(out.length, 1);
  // 2 * 1M * $2.5/MTok = $5.
  assertAlmostEquals(out[0].cost, 5, 1e-9);
});

test('aggregateUsageForDisplay leaves the input record shape untouched', () => {
  const original: UsageRecord = baseRecord({ tokens: { input: 42 } });
  aggregateUsageForDisplay([original]);
  assertEquals(original.model, 'claude-opus-4-7');
  assertEquals(original.tokens.input, 42);
});

test('aggregateUsageForDisplay treats null cost as zero', () => {
  const out = aggregateUsageForDisplay([baseRecord({ cost: null, tokens: { input: 1_000_000 } })]);
  assertEquals(out[0].cost, 0);
});

test('aggregateUsageForDisplay falls back to the input rate when input_cache_read has no dedicated price', () => {
  const cost: ModelPricing = { input: 4, output: 8 };
  const out = aggregateUsageForDisplay([
    baseRecord({ cost, tokens: { input: 500_000, input_cache_read: 500_000 } }),
  ]);
  // input = 500_000 * $4 = 2; input_cache_read = 500_000 * $4 (fallback) = 2; total $4.
  assertAlmostEquals(out[0].cost, 4, 1e-9);
});

test('aggregateUsageForDisplay charges image dimensions separately', () => {
  const cost: ModelPricing = { input: 10, input_image: 5, output: 40, output_image: 30 };
  const out = aggregateUsageForDisplay([
    baseRecord({ cost, tokens: { input: 1_000_000, input_image: 1_000_000, output: 1_000_000, output_image: 1_000_000 } }),
  ]);
  // 10 + 5 + 40 + 30 = $85.
  assertAlmostEquals(out[0].cost, 85, 1e-9);
});

test('aggregateUsageForDisplay reads unit prices from the already-folded cost the repo writer hands back', () => {
  // The repo write path (`repo/sql.ts:dimensionRows`, `repo/memory.ts:dimensionEntries`)
  // resolves the bucket's tier into per-dimension unit prices BEFORE storing,
  // so by the time aggregate sees a UsageRecord the `cost` field is already
  // the effective pricing for that bucket's tier and tier resolution is a
  // no-op. Two same-tier records below model the post-write shape.
  // Opus 4.8: standard $5 / $25, fast $10 / $50.
  const fastRow = baseRecord({
    tier: 'fast',
    cost: { input: 10, output: 50 },
    tokens: { input: 1_000_000, output: 1_000_000 },
  });
  const standardRow = baseRecord({
    tier: null,
    cost: { input: 5, output: 25 },
    tokens: { input: 1_000_000, output: 1_000_000 },
  });

  const fastOut = aggregateUsageForDisplay([fastRow]);
  // 1M * $10 + 1M * $50 = $60.
  assertAlmostEquals(fastOut[0].cost, 60, 1e-9);

  const standardOut = aggregateUsageForDisplay([standardRow]);
  // 1M * $5 + 1M * $25 = $30.
  assertAlmostEquals(standardOut[0].cost, 30, 1e-9);
});

// A (service tier × input length) grid, modeled after GPT-5.6 Sol.
const gridPricing: ModelPricing = {
  input: 5, input_cache_read: 0.5, output: 30,
  tiers: { priority: { input: 10, input_cache_read: 1, output: 60 } },
  inputLengthTiers: [{
    aboveInputTokens: 272000,
    input: 10, input_cache_read: 1, output: 45,
    tiers: { priority: { input: 20, input_cache_read: 2, output: 90 } },
  }],
};

test('aggregateUsageForDisplay charges the whole request at the selected input-length cell, not a marginal overage', () => {
  // 300k input tokens crossed the 272k band, so the entire 300k is charged at
  // the long rate ($10/MTok) — not 272k at $5 plus a 28k overage at $10.
  const out = aggregateUsageForDisplay([
    baseRecord({ cost: gridPricing, tier: null, inputAboveTokens: 272000, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  // 300k * $10 + 100k * $45 = 3 + 4.5 = 7.5.
  assertAlmostEquals(out[0].cost, 3 + 4.5, 1e-9);
});

test('aggregateUsageForDisplay prices the base band lower for the same token counts', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ cost: gridPricing, tier: null, inputAboveTokens: null, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  // 300k * $5 + 100k * $30 = 1.5 + 3 = 4.5.
  assertAlmostEquals(out[0].cost, 1.5 + 3, 1e-9);
});

test('aggregateUsageForDisplay charges the explicit priority-long cell for a two-non-default-selector request', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ cost: gridPricing, tier: 'priority', inputAboveTokens: 272000, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  // 300k * $20 + 100k * $90 = 6 + 9 = 15.
  assertAlmostEquals(out[0].cost, 6 + 9, 1e-9);
});

test('aggregateUsageForDisplay treats a missing (service tier × input length) combination as unpriced (cost 0)', () => {
  const partialGrid: ModelPricing = {
    input: 5, output: 30,
    tiers: { priority: { input: 10, output: 60 } },
    inputLengthTiers: [{ aboveInputTokens: 272000, input: 10, output: 45 }],
  };
  const out = aggregateUsageForDisplay([
    baseRecord({ cost: partialGrid, tier: 'priority', inputAboveTokens: 272000, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  assertAlmostEquals(out[0].cost, 0, 1e-9);
});
