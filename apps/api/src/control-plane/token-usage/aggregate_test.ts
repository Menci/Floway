import { test } from 'vitest';

import { aggregateUsageForDisplay } from './aggregate.ts';
import type { UsageRecord } from '../../repo/types.ts';
import { assertAlmostEquals, assertEquals } from '../../test-assert.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';

const opus47Pricing: ModelPricing = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };
const gpt54Pricing: ModelPricing = { input: 2.5, output: 15, cache_read: 0.25 };

const baseRecord = (overrides: Partial<UsageRecord>): UsageRecord => ({
  keyId: 'key-1',
  hour: '2026-05-01T00',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot',
  modelKey: 'claude-opus-4-7',
  requests: 1,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cost: opus47Pricing,
  ...overrides,
});

test('aggregateUsageForDisplay groups variants that share public model id', () => {
  const records: UsageRecord[] = [
    baseRecord({ requests: 2, inputTokens: 100 }),
    baseRecord({ modelKey: 'claude-opus-4-7-xhigh', requests: 3, inputTokens: 200 }),
    baseRecord({ modelKey: 'claude-opus-4-7-1m-internal', requests: 1, inputTokens: 50 }),
  ];

  const out = aggregateUsageForDisplay(records);
  assertEquals(out.length, 1);
  assertEquals(out[0].model, 'claude-opus-4-7');
  assertEquals(out[0].requests, 6);
  assertEquals(out[0].inputTokens, 350);
  assertEquals('upstream' in out[0], false);
  assertEquals('modelKey' in out[0], false);
});

test('aggregateUsageForDisplay applies cost from each record snapshot', () => {
  const records: UsageRecord[] = [baseRecord({ modelKey: 'claude-opus-4-7-xhigh', inputTokens: 1_000_000 })];
  const out = aggregateUsageForDisplay(records);
  // 1M input * $5/MTok = $5; output 50 tokens * $25/MTok ≈ $0.00125. total ≈ 5.00125.
  assertAlmostEquals(out[0].cost, 5 + (50 * 25) / 1e6, 1e-9);
});

test('aggregateUsageForDisplay sums cost across grouped raw records', () => {
  const records: UsageRecord[] = [
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', cost: gpt54Pricing, inputTokens: 1_000_000, outputTokens: 0 }),
    baseRecord({ model: 'gpt-5.4', modelKey: 'gpt-5.4', cost: gpt54Pricing, inputTokens: 1_000_000, outputTokens: 0 }),
  ];
  const out = aggregateUsageForDisplay(records);
  assertEquals(out.length, 1);
  // 2 * 1M * $2.5/MTok = $5.
  assertAlmostEquals(out[0].cost, 5, 1e-9);
});

test('aggregateUsageForDisplay leaves the input record shape untouched', () => {
  const original: UsageRecord = baseRecord({ inputTokens: 42 });
  aggregateUsageForDisplay([original]);
  assertEquals(original.model, 'claude-opus-4-7');
  assertEquals(original.inputTokens, 42);
});

test('aggregateUsageForDisplay treats null cost as zero', () => {
  const out = aggregateUsageForDisplay([baseRecord({ cost: null, inputTokens: 1_000_000 })]);
  assertEquals(out[0].cost, 0);
});

test('aggregateUsageForDisplay applies cache_read fallback to input when cache_read is omitted', () => {
  const cost: ModelPricing = { input: 4, output: 8 };
  const out = aggregateUsageForDisplay([
    baseRecord({ cost, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000, cacheCreationTokens: 0 }),
  ]);
  // prefill = 500_000 * $4 = 2; cache_read = 500_000 * $4 (fallback) = 2; total $4.
  assertAlmostEquals(out[0].cost, 4, 1e-9);
});
