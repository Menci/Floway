import { test } from 'vitest';

import { pricingForCodexModelKey } from './pricing.ts';
import { resolveEffectivePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

// Every GPT-5.6 variant is a full (service tier × input length) grid:
// standard/priority × short/long. `resolveEffectivePricing(pricing, tier,
// inputAboveTokens)` must return the explicit rates for each of the four cells;
// there is no silent composition of one axis onto the other.
const CODEX_GPT_5_6_GRID = {
  'gpt-5.6-sol': {
    standardShort: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
    priorityShort: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 },
    standardLong: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 },
    priorityLong: { input: 20, input_cache_read: 2, input_cache_write: 25, output: 90 },
  },
  'gpt-5.6-terra': {
    standardShort: { input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 },
    priorityShort: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
    standardLong: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 },
    priorityLong: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 },
  },
  'gpt-5.6-luna': {
    standardShort: { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 },
    priorityShort: { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 12 },
    standardLong: { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 },
    priorityLong: { input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 18 },
  },
} as const;

for (const [modelKey, cells] of Object.entries(CODEX_GPT_5_6_GRID)) {
  test(`Codex ${modelKey} resolves every (service tier × input length) grid cell`, () => {
    const pricing = pricingForCodexModelKey(modelKey);
    assertEquals(resolveEffectivePricing(pricing, null, null), cells.standardShort);
    assertEquals(resolveEffectivePricing(pricing, 'priority', null), cells.priorityShort);
    assertEquals(resolveEffectivePricing(pricing, null, 272000), cells.standardLong);
    assertEquals(resolveEffectivePricing(pricing, 'priority', 272000), cells.priorityLong);
  });

  test(`Codex ${modelKey} declares both explicit inputAboveTokens 272000 cells`, () => {
    const pricing = pricingForCodexModelKey(modelKey);
    assertEquals(pricing?.cells.filter(cell => cell.selector?.inputAboveTokens === 272000).length, 2);
  });
}

test('Codex gpt-5.5 keeps its explicit flex and priority cells', () => {
  const pricing = pricingForCodexModelKey('gpt-5.5');
  assertEquals(resolveEffectivePricing(pricing, null), { input: 5, input_cache_read: 0.5, output: 30 });
  assertEquals(resolveEffectivePricing(pricing, 'flex'), { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(resolveEffectivePricing(pricing, 'priority'), { input: 12.5, input_cache_read: 1.25, output: 75 });
});

test('Codex gpt-5.4 and gpt-5.4-mini keep their explicit flex and priority cells', () => {
  const gpt54 = pricingForCodexModelKey('gpt-5.4');
  assertEquals(resolveEffectivePricing(gpt54, 'flex'), { input: 1.25, input_cache_read: 0.13, output: 7.5 });
  assertEquals(resolveEffectivePricing(gpt54, 'priority'), { input: 5, input_cache_read: 0.5, output: 30 });

  const mini = pricingForCodexModelKey('gpt-5.4-mini');
  assertEquals(resolveEffectivePricing(mini, null), { input: 0.75, input_cache_read: 0.075, output: 4.5 });
  assertEquals(resolveEffectivePricing(mini, 'flex'), { input: 0.375, input_cache_read: 0.0375, output: 2.25 });
  assertEquals(resolveEffectivePricing(mini, 'priority'), { input: 1.5, input_cache_read: 0.15, output: 9 });
});

test('pricingForCodexModelKey returns null for an unknown slug', () => {
  assertEquals(pricingForCodexModelKey('totally-made-up-model'), null);
});
