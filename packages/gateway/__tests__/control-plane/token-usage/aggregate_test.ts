import { test } from 'vitest';

import { aggregateUsageForDisplay } from '../../../src/control-plane/token-usage/aggregate.ts';
import type { TokenUsage, UsageRecord } from '../../../src/repo/types.ts';
import { tokenUsageMetrics } from '../../../src/repo/usage-metrics.ts';
import type { PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const opus47Pricing: PriceVector = { input_tokens: '0.000005', output_tokens: '0.000025', input_cache_read_tokens: '0.0000005', input_cache_write_tokens: '0.00000625' };

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
      input_audio_tokens: undefined,
      input_audio_seconds: undefined,
      rerank_searches: undefined,
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

test('aggregateUsageForDisplay leaves cost unknown when no metrics are priced', () => {
  const out = aggregateUsageForDisplay([baseRecord({ rates: null, tokens: { input: 1_000_000 } })]);
  assertEquals(out[0].cost, null);
});

test('aggregateUsageForDisplay prices audio duration per second', () => {
  const out = aggregateUsageForDisplay([{
    ...baseRecord({ tokens: {} }),
    metrics: [{ metric: 'input_audio_seconds', quantity: '90', unitPrice: '0.01' }],
  }]);
  assertEquals(out[0].cost, '0.9');
});

test('aggregateUsageForDisplay prices different resolved selector snapshots independently', () => {
  const out = aggregateUsageForDisplay([
    baseRecord({ rates: { input_tokens: '0.000005', output_tokens: '0.00003' }, tokens: { input: 300_000, output: 100_000 } }),
    baseRecord({ rates: { input_tokens: '0.00002', output_tokens: '0.00009' }, pricingSelector: { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' }, tokens: { input: 300_000, output: 100_000 } }),
  ]);
  assertEquals(out[0].cost, '19.5');
});
