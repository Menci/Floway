import { test } from 'vitest';

import { aggregateUsageForDisplay } from './aggregate.ts';
import type { TokenUsage, UsageRecord } from '../../repo/types.ts';
import { tokenCountsFromUsage, tokenUsageMetrics } from '../../repo/usage-metrics.ts';
import type { PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const opus47Pricing: PriceVector = { input_tokens: '0.000005', output_tokens: '0.000025', input_cache_read_tokens: '0.0000005', input_cache_write_tokens: '0.00000625' };
const gpt54Pricing: PriceVector = { input_tokens: '0.0000025', output_tokens: '0.000015', input_cache_read_tokens: '0.00000025' };

type RecordOverrides = Omit<Partial<UsageRecord>, 'metrics'> & { tokens?: TokenUsage; rates?: PriceVector | null };

const baseRecord = ({ tokens = { input: 100, output: 50 }, rates = opus47Pricing, ...overrides }: RecordOverrides): UsageRecord => ({
  keyId: 'key-1',
  hour: '2026-05-01T00',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot',
  modelKey: 'claude-opus-4-7',
  pricingSelector: {},
  requests: 1,
  metrics: tokenUsageMetrics(tokens, rates),
  ...overrides,
});

const displayTokens = (record: ReturnType<typeof aggregateUsageForDisplay>[number]): TokenUsage => Object.fromEntries(
  record.metrics.flatMap(row => {
    const key = {
      input_tokens: 'input',
      input_cache_read_tokens: 'input_cache_read',
      input_cache_write_tokens: 'input_cache_write',
      input_cache_write_1h_tokens: 'input_cache_write_1h',
      input_image_tokens: 'input_image',
      output_tokens: 'output',
      output_image_tokens: 'output_image',
    }[row.metric];
    return key ? [[key, Number(row.quantity)]] : [];
  }),
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
  assertEquals(out[0].cost, '5.00125');
});

test('aggregateUsageForDisplay sums cost across grouped raw records', () => {
  const records: UsageRecord[] = [
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', rates: gpt54Pricing, tokens: { input: 1_000_000 } }),
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', rates: gpt54Pricing, tokens: { input: 1_000_000 } }),
  ];
  const out = aggregateUsageForDisplay(records);
  assertEquals(out.length, 1);
  // 2 * 1M * $2.5/MTok = $5.
  assertEquals(out[0].cost, '5');
});

test('aggregateUsageForDisplay leaves the input record shape untouched', () => {
  const original: UsageRecord = baseRecord({ tokens: { input: 42 } });
  aggregateUsageForDisplay([original]);
  assertEquals(original.model, 'claude-opus-4-7');
  assertEquals(tokenCountsFromUsage(original).input, 42);
});

test('aggregateUsageForDisplay leaves cost unknown when no metrics are priced', () => {
  const out = aggregateUsageForDisplay([baseRecord({ rates: null, tokens: { input: 1_000_000 } })]);
  assertEquals(out[0].cost, null);
});

test('aggregateUsageForDisplay leaves metrics without an explicit rate unpriced', () => {
  const rates: PriceVector = { input_tokens: '0.000004', output_tokens: '0.000008' };
  const out = aggregateUsageForDisplay([
    baseRecord({ rates, tokens: { input: 500_000, input_cache_read: 500_000 } }),
  ]);
  // Only input has a rate: 500_000 * $4 = $2. Cache reads remain unpriced.
  assertEquals(out[0].cost, '2');
});

test('aggregateUsageForDisplay charges image metrics separately', () => {
  const rates: PriceVector = { input_tokens: '0.00001', input_image_tokens: '0.000005', output_tokens: '0.00004', output_image_tokens: '0.00003' };
  const out = aggregateUsageForDisplay([
    baseRecord({ rates, tokens: { input: 1_000_000, input_image: 1_000_000, output: 1_000_000, output_image: 1_000_000 } }),
  ]);
  // 10 + 5 + 40 + 30 = $85.
  assertEquals(out[0].cost, '85');
});

test('aggregateUsageForDisplay reads unit prices from the already-folded rates the repo writer hands back', () => {
  // The repo write path receives the request's resolved per-metric rates, so by the time aggregate
  // sees a UsageRecord the `rates` field is already the effective snapshot.
  // Opus 4.8: standard $5 / $25, fast $10 / $50.
  const fastRow = baseRecord({
    pricingSelector: { serviceTier: 'fast' },
    rates: { input_tokens: '0.00001', output_tokens: '0.00005' },
    tokens: { input: 1_000_000, output: 1_000_000 },
  });
  const standardRow = baseRecord({
    pricingSelector: {},
    rates: { input_tokens: '0.000005', output_tokens: '0.000025' },
    tokens: { input: 1_000_000, output: 1_000_000 },
  });

  const fastOut = aggregateUsageForDisplay([fastRow]);
  // 1M * $10 + 1M * $50 = $60.
  assertEquals(fastOut[0].cost, '60');

  const standardOut = aggregateUsageForDisplay([standardRow]);
  // 1M * $5 + 1M * $25 = $30.
  assertEquals(standardOut[0].cost, '30');
});

test('aggregateUsageForDisplay charges the whole request at the selected pricing entry, not a marginal overage', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ rates: { input_tokens: '0.00001', output_tokens: '0.000045' }, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 } }, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  assertEquals(out[0].cost, '7.5');
});

test('aggregateUsageForDisplay prices different resolved selector snapshots independently', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ rates: { input_tokens: '0.000005', output_tokens: '0.00003' }, tokens: { input: 300_000, output: 100_000 } }),
    baseRecord({ rates: { input_tokens: '0.00002', output_tokens: '0.00009' }, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' }, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  assertEquals(out[0].cost, '19.5');
});
