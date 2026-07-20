import { test } from 'vitest';

import { aggregateUsageForDisplay } from './aggregate.ts';
import type { TokenUsage, UsageRecord } from '../../repo/types.ts';
import { tokenCountsFromUsage, tokenUsageDimensions } from '../../repo/usage-dimensions.ts';
import type { PriceVector } from '@floway-dev/protocols/common';
import { assertAlmostEquals, assertEquals } from '@floway-dev/test-utils';

const opus47Pricing: PriceVector = { input: 5, output: 25, input_cache_read: 0.5, input_cache_write: 6.25 };
const gpt54Pricing: PriceVector = { input: 2.5, output: 15, input_cache_read: 0.25 };

type RecordOverrides = Omit<Partial<UsageRecord>, 'dimensions'> & { tokens?: TokenUsage; rates?: PriceVector | null };

const baseRecord = ({ tokens = { input: 100, output: 50 }, rates = opus47Pricing, ...overrides }: RecordOverrides): UsageRecord => ({
  keyId: 'key-1',
  hour: '2026-05-01T00',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot',
  modelKey: 'claude-opus-4-7',
  pricingSelector: {},
  requests: 1,
  dimensions: tokenUsageDimensions(tokens, rates),
  ...overrides,
});

const displayTokens = (record: ReturnType<typeof aggregateUsageForDisplay>[number]): TokenUsage => Object.fromEntries(
  record.dimensions.filter(row => row.unit === 'tokens_1m').map(row => [row.dimension, row.quantity]),
) as TokenUsage;

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
  assertEquals(displayTokens(out[0]).input, 350);
  assertEquals('upstream' in out[0], false);
  assertEquals('modelKey' in out[0], false);
});

test('aggregateUsageForDisplay applies cost from each record rate snapshot', () => {
  const records: UsageRecord[] = [baseRecord({ modelKey: 'claude-opus-4-7-xhigh', tokens: { input: 1_000_000, output: 50 } })];
  const out = aggregateUsageForDisplay(records);
  // 1M input * $5/MTok = $5; output 50 tokens * $25/MTok ≈ $0.00125. total ≈ 5.00125.
  assertAlmostEquals(out[0].cost!, 5 + (50 * 25) / 1e6, 1e-9);
});

test('aggregateUsageForDisplay sums cost across grouped raw records', () => {
  const records: UsageRecord[] = [
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', rates: gpt54Pricing, tokens: { input: 1_000_000 } }),
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', rates: gpt54Pricing, tokens: { input: 1_000_000 } }),
  ];
  const out = aggregateUsageForDisplay(records);
  assertEquals(out.length, 1);
  // 2 * 1M * $2.5/MTok = $5.
  assertAlmostEquals(out[0].cost!, 5, 1e-9);
});

test('aggregateUsageForDisplay leaves the input record shape untouched', () => {
  const original: UsageRecord = baseRecord({ tokens: { input: 42 } });
  aggregateUsageForDisplay([original]);
  assertEquals(original.model, 'claude-opus-4-7');
  assertEquals(tokenCountsFromUsage(original).input, 42);
});

test('aggregateUsageForDisplay leaves cost unknown when no dimensions are priced', () => {
  const out = aggregateUsageForDisplay([baseRecord({ rates: null, tokens: { input: 1_000_000 } })]);
  assertEquals(out[0].cost, null);
});

test('aggregateUsageForDisplay leaves dimensions without an explicit rate unpriced', () => {
  const rates: PriceVector = { input: 4, output: 8 };
  const out = aggregateUsageForDisplay([
    baseRecord({ rates, tokens: { input: 500_000, input_cache_read: 500_000 } }),
  ]);
  // Only input has a rate: 500_000 * $4 = $2. Cache reads remain unpriced.
  assertAlmostEquals(out[0].cost!, 2, 1e-9);
});

test('aggregateUsageForDisplay applies minute and per-thousand-search scales', () => {
  const out = aggregateUsageForDisplay([
    {
      ...baseRecord({ tokens: {} }),
      dimensions: [
        { dimension: 'input', unit: 'minutes', quantity: 90, unitPrice: 0.6 },
        { dimension: 'output', unit: 'searches_1k', quantity: 1_500, unitPrice: 2 },
      ],
    },
  ]);
  assertAlmostEquals(out[0].cost!, 0.9 + 3, 1e-9);
});

test('aggregateUsageForDisplay charges image dimensions separately', () => {
  const rates: PriceVector = { input: 10, input_image: 5, output: 40, output_image: 30 };
  const out = aggregateUsageForDisplay([
    baseRecord({ rates, tokens: { input: 1_000_000, input_image: 1_000_000, output: 1_000_000, output_image: 1_000_000 } }),
  ]);
  // 10 + 5 + 40 + 30 = $85.
  assertAlmostEquals(out[0].cost!, 85, 1e-9);
});

test('aggregateUsageForDisplay reads unit prices from the already-folded rates the repo writer hands back', () => {
  // The repo write path (`repo/sql.ts:dimensionRows`, `repo/memory.ts:dimensionEntries`)
  // receives the request's resolved per-dimension rates, so by the time aggregate
  // sees a UsageRecord the `rates` field is already the effective snapshot.
  // Opus 4.8: standard $5 / $25, fast $10 / $50.
  const fastRow = baseRecord({
    pricingSelector: { serviceTier: 'fast' },
    rates: { input: 10, output: 50 },
    tokens: { input: 1_000_000, output: 1_000_000 },
  });
  const standardRow = baseRecord({
    pricingSelector: {},
    rates: { input: 5, output: 25 },
    tokens: { input: 1_000_000, output: 1_000_000 },
  });

  const fastOut = aggregateUsageForDisplay([fastRow]);
  // 1M * $10 + 1M * $50 = $60.
  assertAlmostEquals(fastOut[0].cost!, 60, 1e-9);

  const standardOut = aggregateUsageForDisplay([standardRow]);
  // 1M * $5 + 1M * $25 = $30.
  assertAlmostEquals(standardOut[0].cost!, 30, 1e-9);
});

test('aggregateUsageForDisplay charges the whole request at the selected pricing entry, not a marginal overage', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ rates: { input: 10, output: 45 }, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } }, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  assertAlmostEquals(out[0].cost!, 7.5, 1e-9);
});

test('aggregateUsageForDisplay prices different resolved selector snapshots independently', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ rates: { input: 5, output: 30 }, tokens: { input: 300_000, output: 100_000 } }),
    baseRecord({ rates: { input: 20, output: 90 }, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' }, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  assertAlmostEquals(out[0].cost!, 4.5 + 15, 1e-9);
});
