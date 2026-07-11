import { test } from 'vitest';

import { pricingForCodexModelKey } from './pricing.ts';
import { resolveEffectivePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

// Every GPT-5.6 variant is a full (service tier × input length) grid:
// standard/priority × short/long. `resolveEffectivePricing(pricing, tier,
// aboveInputTokens)` must return the explicit rates for each of the four cells;
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

  test(`Codex ${modelKey} declares its long band at aboveInputTokens 272000`, () => {
    const pricing = pricingForCodexModelKey(modelKey);
    assertEquals(pricing?.inputLengthTiers?.map(t => t.aboveInputTokens), [272000]);
  });
}

test('Codex flex/priority families outside GPT-5.6 keep their base-length service overlays', () => {
  const gpt54 = pricingForCodexModelKey('gpt-5.4');
  assertEquals(resolveEffectivePricing(gpt54, 'flex', null), { input: 1.25, input_cache_read: 0.13, output: 7.5 });
  assertEquals(resolveEffectivePricing(gpt54, 'priority', null), { input: 5, input_cache_read: 0.5, output: 30 });
});

test('pricingForCodexModelKey returns null for an unknown slug', () => {
  assertEquals(pricingForCodexModelKey('totally-made-up-model'), null);
});
