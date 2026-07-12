import { test } from 'vitest';

import {
  basePricing,
  canonicalPricingSelectorKey,
  canonicalizePricingSelector,
  modelPricing,
  parsePricingSelectorKey,
  priceRequest,
  pricingEntry,
  validateModelPricing,
  type ModelPricing,
  type PricingSelector,
} from './models.ts';
import { assertEquals, assertThrows } from '../test-assert.ts';

test('canonical selector JSON sorts axis keys and threshold object keys deterministically', () => {
  const first: PricingSelector = { serviceTier: 'priority', inputTokens: { value: 272000, operator: 'gt' } };
  const second: PricingSelector = { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' };
  const expected = '{"inputTokens":{"operator":"gt","value":272000},"serviceTier":"priority"}';
  assertEquals(canonicalPricingSelectorKey(first), expected);
  assertEquals(canonicalPricingSelectorKey(second), expected);
  assertEquals(canonicalPricingSelectorKey(undefined), '{}');
  assertEquals(parsePricingSelectorKey(expected), { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' });
});

test('parsePricingSelectorKey rejects noncanonical JSON', () => {
  assertThrows(() => parsePricingSelectorKey('{"serviceTier":"priority","inputTokens":{"operator":"gt","value":272000}}'), Error, 'not canonical');
});

test('selector validation rejects unknown axes, empty equality values, and malformed thresholds', () => {
  assertThrows(() => canonicalizePricingSelector({ unknown: 'x' }), RangeError, 'unknown pricing selector axis');
  assertThrows(() => canonicalizePricingSelector({ serviceTier: '' }), RangeError, 'non-empty string');
  assertThrows(() => canonicalizePricingSelector({ inputTokens: { operator: 'eq' as 'gt', value: 1 } }), RangeError, '"gt" or "gte"');
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(() => canonicalizePricingSelector({ inputTokens: { operator: 'gt', value } }), RangeError, 'positive safe integer');
  }
});

test('model validation rejects duplicate selectors and equal numeric thresholds even with different operators', () => {
  assertThrows(() => validateModelPricing({ entries: [{ rates: { input: 1 } }, { selector: {}, rates: { input: 2 } }] }), Error, 'duplicate pricing entry selector');
  assertThrows(() => validateModelPricing({
    entries: [
      { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input: 1 } },
      { selector: { inputTokens: { operator: 'gte', value: 272000 } }, rates: { input: 2 } },
    ],
  }), Error, 'conflicting pricing threshold operators');
});

test('model validation requires every entry to price the same dimensions', () => {
  assertThrows(
    () => validateModelPricing({
      entries: [
        { rates: { input: 1, output: 4 } },
        { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
      ],
    }),
    Error,
    'must define the same dimensions as entry 0 (input, output)',
  );
  validateModelPricing({
    entries: [
      { rates: { input: 1, output: 4 } },
      { selector: { serviceTier: 'priority' }, rates: { output: 8, input: 2 } },
    ],
  });
});

test('model validation rejects service-specific thresholds without a global band', () => {
  assertThrows(
    () => validateModelPricing({
      entries: [
        { rates: { input: 1 } },
        {
          selector: { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 272000 } },
          rates: { input: 4 },
        },
      ],
    }),
    Error,
    'pricing threshold selector {"inputTokens":{"operator":"gt","value":272000}} must be declared without equality coordinates',
  );
});

test('shared pricing helpers canonicalize and eagerly validate catalogs', () => {
  assertEquals(basePricing({ input: 1 }), { entries: [{ rates: { input: 1 } }] });
  assertEquals(modelPricing(
    pricingEntry({ input: 1 }),
    pricingEntry({ input: 2 }, { serviceTier: 'priority' }),
  ), {
    entries: [
      { rates: { input: 1 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
    ],
  });
  assertThrows(
    () => modelPricing(pricingEntry({ input: 1 }), pricingEntry({ input: 2 })),
    Error,
    'duplicate pricing entry selector',
  );
});

const GRID: ModelPricing = {
  entries: [
    { rates: { input: 5, output: 30 } },
    { selector: { serviceTier: 'priority' }, rates: { input: 10, output: 60 } },
    { selector: { inputTokens: { operator: 'gt', value: 128000 } }, rates: { input: 7, output: 40 } },
    { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input: 10, output: 45 } },
    { selector: { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 128000 } }, rates: { input: 14, output: 80 } },
  ],
};

test('priceRequest applies gt boundaries and selects the highest matching threshold', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 128000 }), { selector: {}, rates: { input: 5, output: 30 } });
  assertEquals(priceRequest(GRID, { inputTokens: 128001 }).rates, { input: 7, output: 40 });
  assertEquals(priceRequest(GRID, { inputTokens: 272000 }).rates, { input: 7, output: 40 });
  assertEquals(priceRequest(GRID, { inputTokens: 272001 }).rates, { input: 10, output: 45 });
});

test('priceRequest applies gte at the exact boundary', () => {
  const pricing: ModelPricing = {
    entries: [
      { rates: { input: 1 } },
      { selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input: 2 } },
    ],
  };
  assertEquals(priceRequest(pricing, { inputTokens: 99 }).rates, { input: 1 });
  assertEquals(priceRequest(pricing, { inputTokens: 100 }).rates, { input: 2 });
});

test('priceRequest exact-matches every axis and leaves missing combinations unpriced', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 0, serviceTier: 'priority' }).rates, { input: 10, output: 60 });
  assertEquals(priceRequest(GRID, { inputTokens: 128001, serviceTier: 'priority' }).rates, { input: 14, output: 80 });
  const missing = priceRequest(GRID, { inputTokens: 272001, serviceTier: 'priority' });
  assertEquals(missing.rates, null);
  assertEquals(missing.selector, { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' });
});

test('unknown runtime service tier remains a coordinate and exact-missing is unpriced', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 0, serviceTier: 'future' }), {
    selector: { serviceTier: 'future' },
    rates: null,
  });
});

test('priceRequest preserves equality facts even when pricing is unavailable', () => {
  assertEquals(priceRequest(null, { inputTokens: 1, serviceTier: 'future' }), {
    selector: { serviceTier: 'future' },
    rates: null,
  });
});
