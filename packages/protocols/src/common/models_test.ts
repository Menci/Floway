import { test } from 'vitest';

import {
  tokenBasePricing,
  canonicalPricingSelectorKey,
  canonicalizePricingSelector,
  collectModelPricingIssues,
  tokenModelPricing,
  parseBillingDimension,
  parseBillingUnit,
  parsePricingSelectorKey,
  parseModelKind,
  priceRequest,
  pricingEntry,
  validateModelPricing,
  type ModelPricing,
  type PricingSelector,
} from './models.ts';
import { assertEquals, assertThrows } from '../test-assert.ts';

test('parseModelKind accepts the current model families and rejects unknown storage values', () => {
  for (const kind of ['chat', 'embedding', 'image', 'audio'] as const) assertEquals(parseModelKind(kind), kind);
  assertThrows(() => parseModelKind('video'), TypeError, 'Invalid model kind: "video"');
  assertThrows(() => parseModelKind(null), TypeError, 'Invalid model kind: null');
});

test('billing storage parsers accept current vocabulary and reject unknown values', () => {
  assertEquals(parseBillingDimension('input'), 'input');
  assertEquals(parseBillingUnit('tokens_1m'), 'tokens_1m');
  assertEquals(parseBillingUnit('minutes'), 'minutes');
  assertThrows(() => parseBillingDimension('reasoning'), TypeError, 'billing dimension is invalid: "reasoning"');
  assertThrows(() => parseBillingUnit('requests'), TypeError, 'billing unit is invalid: "requests"');
});

test('canonical selector JSON sorts axis keys and threshold object keys deterministically', () => {
  const first: PricingSelector = { serviceTier: 'priority', inputTokens: { value: 272000, operator: 'gt' } };
  const second: PricingSelector = { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' };
  const expected = '{"inputTokens":{"operator":"gt","value":272000},"serviceTier":"priority"}';
  assertEquals(canonicalPricingSelectorKey(first), expected);
  assertEquals(canonicalPricingSelectorKey(second), expected);
  assertEquals(canonicalPricingSelectorKey(undefined), '{}');
  assertEquals(parsePricingSelectorKey(expected), { inputTokens: { operator: 'gt', value: 272000 }, serviceTier: 'priority' });
});

test('canonical selectors reject unknown threshold fields', () => {
  assertThrows(
    () => canonicalizePricingSelector({ inputTokens: { operator: 'gt', value: 100, unit: 'tokens' } } as never),
    RangeError,
    'unknown fields: unit',
  );
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

test('model validation rejects duplicate selectors and conflicting threshold operators in overlapping scopes', () => {
  assertThrows(() => validateModelPricing({
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 3 } },
    ],
  }), Error, 'duplicate pricing entry selector');
  assertThrows(() => validateModelPricing({
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input: 1 } },
      { selector: { inputTokens: { operator: 'gte', value: 272000 } }, rates: { input: 2 } },
    ],
  }), Error, 'conflicting pricing threshold operators');
  validateModelPricing({
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 16 } }, rates: { input: 2 } },
      { selector: { serviceTier: 'priority', inputTokens: { operator: 'gte', value: 16 } }, rates: { input: 3 } },
    ],
  });
  assertThrows(() => validateModelPricing({
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { inputTokens: { operator: 'gt', value: 16 } }, rates: { input: 2 } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gte', value: 16 } }, rates: { input: 3 } },
    ],
  }), Error, 'overlapping equality scopes');
});

test('model validation requires exactly one base entry and uses it as the rate-field reference', () => {
  assertThrows(() => validateModelPricing({
    units: { input: 'tokens_1m' },
    entries: [{ selector: { serviceTier: 'priority' }, rates: { input: 2 } }],
  }), Error, 'exactly one base entry');
  assertThrows(() => validateModelPricing({
    units: { input: 'tokens_1m' },
    entries: [{ rates: { input: 1 } }, { selector: {}, rates: { input: 2 } }],
  }), Error, 'exactly one base entry');
  validateModelPricing({
    units: { input: 'tokens_1m', output: 'tokens_1m' },
    entries: [
      { selector: { serviceTier: 'priority' }, rates: { input: 2, output: 8 } },
      { rates: { input: 1, output: 4 } },
    ],
  });
});

test('model validation requires every entry to price the same dimensions', () => {
  assertThrows(
    () => validateModelPricing({
      units: { input: 'tokens_1m', output: 'tokens_1m' },
      entries: [
        { rates: { input: 1, output: 4 } },
        { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
      ],
    }),
    Error,
    'must define the same dimensions as the base entry (input, output)',
  );
  validateModelPricing({
    units: { input: 'tokens_1m', output: 'tokens_1m' },
    entries: [
      { rates: { input: 1, output: 4 } },
      { selector: { serviceTier: 'priority' }, rates: { output: 8, input: 2 } },
    ],
  });
});

test('structured pricing issues identify entries, selectors, and rate-dimension differences', () => {
  const issues = collectModelPricingIssues({
    units: { input: 'tokens_1m', output: 'tokens_1m' },
    entries: [
      { rates: { input: 1, output: 4 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 3 } },
    ],
  }).map(({ error: _error, ...issue }) => issue);
  assertEquals(issues, [
    { code: 'rate-dimensions', entryIndex: 1, baseIndex: 0, missingDimensions: ['output'], addedDimensions: [] },
    { code: 'rate-dimensions', entryIndex: 2, baseIndex: 0, missingDimensions: ['output'], addedDimensions: [] },
    {
      code: 'duplicate-selector',
      selector: { serviceTier: 'priority' },
      selectorKey: '{"serviceTier":"priority"}',
      entryIndexes: [1, 2],
    },
  ]);
  assertEquals(collectModelPricingIssues({
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { serviceTier: '' }, rates: { input: 2 } },
    ],
  }).map(issue => ({ code: issue.code, ...('entryIndex' in issue ? { entryIndex: issue.entryIndex } : {}) })), [
    { code: 'invalid-selector', entryIndex: 1 },
  ]);
});

test('catalog validation rejects Base-equivalent tiers without narrowing historical selector parsing', () => {
  for (const serviceTier of ['default', ' Standard ', '  ']) {
    const issues = collectModelPricingIssues({
      units: { input: 'tokens_1m' },
      entries: [
        { rates: { input: 1 } },
        { selector: { serviceTier }, rates: { input: 2 } },
      ],
    });
    assertEquals(issues.map(issue => ({ code: issue.code, ...('entryIndex' in issue ? { entryIndex: issue.entryIndex } : {}) })), [
      { code: 'invalid-selector', entryIndex: 1 },
    ]);
    assertEquals(canonicalizePricingSelector({ serviceTier }), { serviceTier });
  }
});

test('service-specific thresholds remain scoped while global thresholds apply to every service tier', () => {
  const pricing: ModelPricing = {
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { serviceTier: 'fast' }, rates: { input: 2 } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 16 } }, rates: { input: 3 } },
      { selector: { inputTokens: { operator: 'gt', value: 100 } }, rates: { input: 4 } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 200 } }, rates: { input: 5 } },
    ],
  };
  assertEquals(priceRequest(pricing, { inputTokens: 17 }), { selector: {}, units: { input: 'tokens_1m' }, rates: { input: 1 } });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 16 }).rates, { input: 2 });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 17 }), {
    selector: { inputTokens: { operator: 'gt', value: 16 }, serviceTier: 'fast' },
    units: { input: 'tokens_1m' },
    rates: { input: 3 },
  });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 101 }), { selector: {}, units: { input: 'tokens_1m' }, rates: { input: 1 } });
  assertEquals(priceRequest(pricing, { serviceTier: 'fast', inputTokens: 201 }), {
    selector: { inputTokens: { operator: 'gt', value: 200 }, serviceTier: 'fast' },
    units: { input: 'tokens_1m' },
    rates: { input: 5 },
  });
});

test('shared pricing helpers canonicalize and eagerly validate catalogs', () => {
  assertEquals(tokenBasePricing({ input: 1 }), { units: { input: 'tokens_1m' }, entries: [{ rates: { input: 1 } }] });
  assertEquals(tokenModelPricing(
    pricingEntry({ input: 1 }),
    pricingEntry({ input: 2 }, { serviceTier: 'priority' }),
  ), {
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 2 } },
    ],
  });
  assertThrows(
    () => tokenModelPricing(
      pricingEntry({ input: 1 }),
      pricingEntry({ input: 2 }, { serviceTier: 'priority' }),
      pricingEntry({ input: 3 }, { serviceTier: 'priority' }),
    ),
    Error,
    'duplicate pricing entry selector',
  );
  assertThrows(
    () => tokenModelPricing(pricingEntry({ input: 1 }, { serviceTier: 'priority' })),
    Error,
    'exactly one base entry',
  );
});

const GRID: ModelPricing = {
  units: { input: 'tokens_1m', output: 'tokens_1m' },
  entries: [
    { rates: { input: 5, output: 30 } },
    { selector: { serviceTier: 'priority' }, rates: { input: 10, output: 60 } },
    { selector: { inputTokens: { operator: 'gt', value: 128000 } }, rates: { input: 7, output: 40 } },
    { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input: 10, output: 45 } },
    { selector: { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 128000 } }, rates: { input: 14, output: 80 } },
  ],
};

test('priceRequest applies gt boundaries and selects the highest matching threshold', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 128000 }), { selector: {}, units: GRID.units, rates: { input: 5, output: 30 } });
  assertEquals(priceRequest(GRID, { inputTokens: 128001 }).rates, { input: 7, output: 40 });
  assertEquals(priceRequest(GRID, { inputTokens: 272000 }).rates, { input: 7, output: 40 });
  assertEquals(priceRequest(GRID, { inputTokens: 272001 }).rates, { input: 10, output: 45 });
});

test('priceRequest applies gte at the exact boundary', () => {
  const pricing: ModelPricing = {
    units: { input: 'tokens_1m' },
    entries: [
      { rates: { input: 1 } },
      { selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input: 2 } },
    ],
  };
  assertEquals(priceRequest(pricing, { inputTokens: 99 }).rates, { input: 1 });
  assertEquals(priceRequest(pricing, { inputTokens: 100 }).rates, { input: 2 });
});

test('priceRequest exact-matches every axis and falls back wholesale to Base on a missing combination', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 0, serviceTier: 'priority' }).rates, { input: 10, output: 60 });
  assertEquals(priceRequest(GRID, { inputTokens: 128001, serviceTier: 'priority' }).rates, { input: 14, output: 80 });
  const missing = priceRequest(GRID, { inputTokens: 272001, serviceTier: 'priority' });
  assertEquals(missing, { selector: {}, units: GRID.units, rates: { input: 5, output: 30 } });
});

test('unknown runtime service tier falls back to Base', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 0, serviceTier: 'future' }), {
    selector: {},
    units: GRID.units,
    rates: { input: 5, output: 30 },
  });
});

test('priceRequest preserves equality facts only when model pricing is unavailable', () => {
  assertEquals(priceRequest(null, { inputTokens: 1, serviceTier: 'future' }), {
    selector: { serviceTier: 'future' },
    units: null,
    rates: null,
  });
});
