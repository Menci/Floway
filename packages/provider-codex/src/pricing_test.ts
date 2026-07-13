import { test } from 'vitest';

import { pricingForCodexModelKey } from './pricing.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

// Every GPT-5.6 variant is a full (service tier × input length) grid:
// standard/priority × short/long. `priceRequest(pricing, tier,
// inputTokens threshold)` must return the explicit rates for each of the four entries;
// there is no silent composition of one axis onto the other.
const CODEX_GPT_5_6_GRID = {
  'gpt-5.6-sol': {
    standardShort: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
    priorityShort: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 },
    standardLong: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 },
    priorityLong: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
  },
  'gpt-5.6-terra': {
    standardShort: { input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 },
    priorityShort: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
    standardLong: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 },
    priorityLong: { input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 },
  },
  'gpt-5.6-luna': {
    standardShort: { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 },
    priorityShort: { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 12 },
    standardLong: { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 },
    priorityLong: { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 },
  },
} as const;

for (const [modelKey, entries] of Object.entries(CODEX_GPT_5_6_GRID)) {
  test(`Codex ${modelKey} resolves every (service tier × input length) grid entry`, () => {
    const pricing = pricingForCodexModelKey(modelKey);
    assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, entries.standardShort);
    assertEquals(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 0 }).rates, entries.priorityShort);
    assertEquals(priceRequest(pricing, { inputTokens: 272000 + 1 }).rates, entries.standardLong);
    assertEquals(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 272000 + 1 }).rates, entries.priorityLong);
  });

  test(`Codex ${modelKey} declares one standard inputTokens >272000 entry`, () => {
    const pricing = pricingForCodexModelKey(modelKey);
    assertEquals(pricing?.entries.filter(entry => {
      const coordinate = entry.selector?.inputTokens;
      return typeof coordinate === 'object' && coordinate.operator === 'gt' && coordinate.value === 272000;
    }).length, 1);
  });
}

test('Codex gpt-5.5 keeps its explicit flex and priority entries', () => {
  const pricing = pricingForCodexModelKey('gpt-5.5');
  assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, { input: 5, input_cache_read: 0.5, output: 30 });
  assertEquals(priceRequest(pricing, { serviceTier: 'flex', inputTokens: 0 }).rates, { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 0 }).rates, { input: 12.5, input_cache_read: 1.25, output: 75 });
});

test('Codex gpt-5.4 and gpt-5.4-mini keep their explicit flex and priority entries', () => {
  const gpt54 = pricingForCodexModelKey('gpt-5.4');
  assertEquals(priceRequest(gpt54, { serviceTier: 'flex', inputTokens: 0 }).rates, { input: 1.25, input_cache_read: 0.13, output: 7.5 });
  assertEquals(priceRequest(gpt54, { serviceTier: 'priority', inputTokens: 0 }).rates, { input: 5, input_cache_read: 0.5, output: 30 });
  assertEquals(priceRequest(gpt54, { inputTokens: 272001 }).rates, { input: 5, input_cache_read: 0.5, output: 22.5 });
  assertEquals(priceRequest(gpt54, { serviceTier: 'priority', inputTokens: 272001 }).rates, { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(priceRequest(gpt54, { serviceTier: 'flex', inputTokens: 272001 }).rates, { input: 2.5, input_cache_read: 0.25, output: 15 });

  const mini = pricingForCodexModelKey('gpt-5.4-mini');
  assertEquals(priceRequest(mini, { inputTokens: 0 }).rates, { input: 0.75, input_cache_read: 0.075, output: 4.5 });
  assertEquals(priceRequest(mini, { serviceTier: 'flex', inputTokens: 0 }).rates, { input: 0.375, input_cache_read: 0.0375, output: 2.25 });
  assertEquals(priceRequest(mini, { serviceTier: 'priority', inputTokens: 0 }).rates, { input: 1.5, input_cache_read: 0.15, output: 9 });
});

test('pricingForCodexModelKey returns null for an unknown slug', () => {
  assertEquals(pricingForCodexModelKey('totally-made-up-model'), null);
});
