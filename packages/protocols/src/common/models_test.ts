import { test } from 'vitest';

import {
  tokenBasePricing,
  canonicalPricingSelectorKey,
  canonicalizePricingSelector,
  collectModelPricingIssues,
  tokenModelPricing,
  tokenPricingEntry,
  parseBillingMetric,
  parsePricingSelectorKey,
  priceRequest,
  validateModelPricing,
  type ModelPricing,
  type PricingSelector,
} from './models.ts';
import { assertEquals, assertThrows } from '../test-assert.ts';

test('billing storage parsers accept current vocabulary and reject unknown values', () => {
  assertEquals(parseBillingMetric('input_tokens'), 'input_tokens');
  assertEquals(parseBillingMetric('rerank_searches'), 'rerank_searches');
  assertThrows(() => parseBillingMetric('reasoning'), TypeError, 'billing metric is invalid: "reasoning"');
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

test('model validation requires every entry to price the same metrics', () => {
  assertThrows(
    () => validateModelPricing({
      entries: [
        { rates: { input_tokens: '1', output_tokens: '4' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      ],
    }),
    Error,
    'must define the same metrics as the base entry (input_tokens, output_tokens)',
  );
  validateModelPricing({
    entries: [
      { rates: { input_tokens: '1', output_tokens: '4' } },
      { selector: { serviceTier: 'priority' }, rates: { output_tokens: '8', input_tokens: '2' } },
    ],
  });
});

test('structured pricing issues identify entries, selectors, and rate-metric differences', () => {
  const issues = collectModelPricingIssues({
    entries: [
      { rates: { input_tokens: '1', output_tokens: '4' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3' } },
    ],
  }).map(({ error: _error, ...issue }) => issue);
  assertEquals(issues, [
    { code: 'rate-metrics', entryIndex: 1, baseIndex: 0, missingMetrics: ['output_tokens'], addedMetrics: [] },
    { code: 'rate-metrics', entryIndex: 2, baseIndex: 0, missingMetrics: ['output_tokens'], addedMetrics: [] },
    {
      code: 'duplicate-selector',
      selector: { serviceTier: 'priority' },
      selectorKey: '{"serviceTier":"priority"}',
      entryIndexes: [1, 2],
    },
  ]);
  assertEquals(collectModelPricingIssues({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: '' }, rates: { input_tokens: '2' } },
    ],
  }).map(issue => ({ code: issue.code, ...('entryIndex' in issue ? { entryIndex: issue.entryIndex } : {}) })), [
    { code: 'invalid-selector', entryIndex: 1 },
  ]);
});

test('catalog validation rejects Base-equivalent tiers without narrowing historical selector parsing', () => {
  for (const serviceTier of ['default', ' Standard ', '  ']) {
    const issues = collectModelPricingIssues({
      entries: [
        { rates: { input_tokens: '1' } },
        { selector: { serviceTier }, rates: { input_tokens: '2' } },
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

test('shared pricing helpers canonicalize and eagerly validate catalogs', () => {
  assertEquals(tokenBasePricing({ input_tokens: '1' }), { entries: [{ rates: { input_tokens: '0.000001' } }] });
  assertEquals(tokenModelPricing(
    tokenPricingEntry({ input_tokens: '1' }),
    tokenPricingEntry({ input_tokens: '2' }, { serviceTier: 'priority' }),
  ), {
    entries: [
      { rates: { input_tokens: '0.000001' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '0.000002' } },
    ],
  });
  assertThrows(
    () => tokenModelPricing(
      tokenPricingEntry({ input_tokens: '1' }),
      tokenPricingEntry({ input_tokens: '2' }, { serviceTier: 'priority' }),
      tokenPricingEntry({ input_tokens: '3' }, { serviceTier: 'priority' }),
    ),
    Error,
    'duplicate pricing entry selector',
  );
  assertThrows(
    () => tokenModelPricing(tokenPricingEntry({ input_tokens: '1' }, { serviceTier: 'priority' })),
    Error,
    'exactly one base entry',
  );
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

test('priceRequest applies gte at the exact boundary', () => {
  const pricing: ModelPricing = {
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { inputTokens: { operator: 'gte', value: 100 } }, rates: { input_tokens: '2' } },
    ],
  };
  assertEquals(priceRequest(pricing, { inputTokens: 99 }).rates, { input_tokens: '1' });
  assertEquals(priceRequest(pricing, { inputTokens: 100 }).rates, { input_tokens: '2' });
});

test('priceRequest exact-matches every axis and falls back wholesale to Base on a missing combination', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 0, serviceTier: 'priority' }).rates, { input_tokens: '10', output_tokens: '60' });
  assertEquals(priceRequest(GRID, { inputTokens: 128001, serviceTier: 'priority' }).rates, { input_tokens: '14', output_tokens: '80' });
  const missing = priceRequest(GRID, { inputTokens: 272001, serviceTier: 'priority' });
  assertEquals(missing, { selector: {}, rates: { input_tokens: '5', output_tokens: '30' } });
});

test('unknown runtime service tier falls back to Base', () => {
  assertEquals(priceRequest(GRID, { inputTokens: 0, serviceTier: 'future' }), {
    selector: {},
    rates: { input_tokens: '5', output_tokens: '30' },
  });
});

test('priceRequest preserves equality facts only when model pricing is unavailable', () => {
  assertEquals(priceRequest(null, { inputTokens: 1, serviceTier: 'future' }), {
    selector: { serviceTier: 'future' },
    rates: null,
  });
});
