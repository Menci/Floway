import { test } from 'vitest';

import {
  canonicalPricingSelectorKey,
  canonicalizePricingSelector,
  parsePricingSelectorKey,
  priceRequest,
  validateModelPricing,
  type ModelPricing,
  type PricingSelector,
} from '../../src/common/pricing.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('canonical selector JSON sorts axis keys and threshold object keys deterministically', () => {
  const first: PricingSelector = { serviceTier: 'priority', inputTokens: { value: 272000, operator: 'gt' } };
  const second: PricingSelector = { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' };
  const expected = '{"inputTokens":{"operator":"gt","value":272000},"serviceTier":"priority"}';
  assertEquals(canonicalPricingSelectorKey(first), expected);
  assertEquals(canonicalPricingSelectorKey(second), expected);
  assertEquals(canonicalPricingSelectorKey(undefined), '{}');
  assertEquals(parsePricingSelectorKey(expected), { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' });
});

test('selector validation rejects unknown axes, empty equality values, and malformed thresholds', () => {
  assertThrows(() => canonicalizePricingSelector({ unknown: 'x' }), RangeError, 'unknown pricing selector axis');
  assertThrows(() => canonicalizePricingSelector({ serviceTier: '' }), RangeError, 'non-empty string');
  assertThrows(() => canonicalizePricingSelector({ inputTokens: { operator: 'eq' as 'gt', value: 1 } }), RangeError, '"gt" or "gte"');
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(() => canonicalizePricingSelector({ inputTokens: { operator: 'gt', value } }), RangeError, 'positive safe integer');
  }
});

test('model validation rejects duplicate selectors and conflicting threshold operators in overlapping scopes', () => {
  assertThrows(() => validateModelPricing({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3' } },
    ],
  }), Error, 'duplicate pricing entry selector');
  assertThrows(() => validateModelPricing({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '1' } },
      { selector: { inputTokens: { operator: 'gte', value: 272000 } }, rates: { input_tokens: '2' } },
    ],
  }), Error, 'conflicting pricing threshold operators');
  validateModelPricing({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 16 } }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'priority', inputTokens: { operator: 'gte', value: 16 } }, rates: { input_tokens: '3' } },
    ],
  });
  assertThrows(() => validateModelPricing({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { inputTokens: { operator: 'gt', value: 16 } }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gte', value: 16 } }, rates: { input_tokens: '3' } },
    ],
  }), Error, 'overlapping equality scopes');
});

test('model validation requires exactly one base entry and uses it as the rate-field reference', () => {
  assertThrows(() => validateModelPricing({
    entries: [{ selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } }],
  }), Error, 'exactly one base entry');
  assertThrows(() => validateModelPricing({
    entries: [{ rates: { input_tokens: '1' } }, { selector: {}, rates: { input_tokens: '2' } }],
  }), Error, 'exactly one base entry');
  validateModelPricing({
    entries: [
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2', output_tokens: '8' } },
      { rates: { input_tokens: '1', output_tokens: '4' } },
    ],
  });
});

test('service-specific thresholds remain scoped while global thresholds apply to every service tier', () => {
  const pricing: ModelPricing = {
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: 'fast' }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 16 } }, rates: { input_tokens: '3' } },
      { selector: { inputTokens: { operator: 'gt', value: 100 } }, rates: { input_tokens: '4' } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 200 } }, rates: { input_tokens: '5' } },
    ],
  };
  assertEquals(priceRequest(pricing, { inputTokens: 17 }), { selector: {}, rates: { input_tokens: '1' } });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 16 }).rates, { input_tokens: '2' });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 17 }), {
    selector: { inputTokens: { operator: 'gt', value: 16 }, serviceTier: 'fast' },
    rates: { input_tokens: '3' },
  });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 101 }), { selector: {}, rates: { input_tokens: '1' } });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 201 }), {
    selector: { inputTokens: { operator: 'gt', value: 200 }, serviceTier: 'fast' },
    rates: { input_tokens: '5' },
  });
});

const GRID: ModelPricing = {
  entries: [
    { rates: { input_tokens: '5', output_tokens: '30' } },
    { selector: { serviceTier: 'priority' }, rates: { input_tokens: '10', output_tokens: '60' } },
    { selector: { inputTokens: { operator: 'gt', value: 128000 } }, rates: { input_tokens: '7', output_tokens: '40' } },
    { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '10', output_tokens: '45' } },
    { selector: { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 128000 } }, rates: { input_tokens: '14', output_tokens: '80' } },
  ],
};

test('priceRequest applies gt boundaries and selects the highest matching threshold', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 128000 }), { selector: {}, rates: { input_tokens: '5', output_tokens: '30' } });
  assertEquals(priceRequest(GRID, { inputTokens: 128001 }).rates, { input_tokens: '7', output_tokens: '40' });
  assertEquals(priceRequest(GRID, { inputTokens: 272000 }).rates, { input_tokens: '7', output_tokens: '40' });
  assertEquals(priceRequest(GRID, { inputTokens: 272001 }).rates, { input_tokens: '10', output_tokens: '45' });
});
