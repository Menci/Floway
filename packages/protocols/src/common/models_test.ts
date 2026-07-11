import { test } from 'vitest';

import { resolveEffectivePricing, selectInputLengthTier, unitPriceForDimension, type ModelPricing } from './models.ts';
import { assertEquals, assertThrows } from '../test-assert.ts';

test('unitPriceForDimension returns null when pricing snapshot is null', () => {
  assertEquals(unitPriceForDimension(null, 'input'), null);
  assertEquals(unitPriceForDimension(null, 'input_cache_write_1h'), null);
});

test('unitPriceForDimension prefers dimension-specific rates', () => {
  const pricing = { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_cache_write_1h: 2, output: 5 };
  assertEquals(unitPriceForDimension(pricing, 'input'), 1);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_read'), 0.1);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write'), 1.25);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 2);
  assertEquals(unitPriceForDimension(pricing, 'output'), 5);
});

test('unitPriceForDimension applies only the within-vector fallback chain', () => {
  assertEquals(unitPriceForDimension({ input: 1, input_cache_write: 1.25 }, 'input_cache_write_1h'), 1.25);
  assertEquals(unitPriceForDimension({ input: 1 }, 'input_cache_write_1h'), 1);
  assertEquals(unitPriceForDimension({}, 'input_cache_write_1h'), null);
});

const GRID: ModelPricing = {
  cells: [
    { rates: { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 } },
    { selector: { serviceTier: 'priority' }, rates: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 } },
    { selector: { inputAboveTokens: 272000 }, rates: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 } },
    { selector: { serviceTier: 'priority', inputAboveTokens: 272000 }, rates: { input: 20, input_cache_read: 2, input_cache_write: 25, output: 90 } },
  ],
};

test('selectInputLengthTier treats input thresholds as strictly greater', () => {
  assertEquals(selectInputLengthTier(GRID, 271999), null);
  assertEquals(selectInputLengthTier(GRID, 272000), null);
  assertEquals(selectInputLengthTier(GRID, 272001), 272000);
});

test('selectInputLengthTier discovers the highest crossed threshold independently of service tier', () => {
  const pricing: ModelPricing = {
    cells: [
      { rates: { input: 1 } },
      { selector: { serviceTier: 'fast', inputAboveTokens: 128000 }, rates: { input: 2 } },
      { selector: { inputAboveTokens: 272000 }, rates: { input: 4 } },
    ],
  };
  assertEquals(selectInputLengthTier(pricing, 128000), null);
  assertEquals(selectInputLengthTier(pricing, 128001), 128000);
  assertEquals(selectInputLengthTier(pricing, 272001), 272000);
  assertEquals(selectInputLengthTier(null, 300000), null);
});

test('resolveEffectivePricing exact-matches every Cartesian coordinate', () => {
  assertEquals(resolveEffectivePricing(GRID, null, null), { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 });
  assertEquals(resolveEffectivePricing(GRID, 'priority', null), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 });
  assertEquals(resolveEffectivePricing(GRID, null, 272000), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 });
  assertEquals(resolveEffectivePricing(GRID, 'priority', 272000), { input: 20, input_cache_read: 2, input_cache_write: 25, output: 90 });
});

test('resolveEffectivePricing never inherits rates across cells', () => {
  const pricing: ModelPricing = {
    cells: [
      { rates: { input: 5, input_cache_read: 0.5, output: 30 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 10 } },
    ],
  };
  assertEquals(resolveEffectivePricing(pricing, 'priority', null), { input: 10 });
});

test('resolveEffectivePricing returns null for every missing exact coordinate', () => {
  const pricing: ModelPricing = {
    cells: [
      { rates: { input: 5, output: 30 } },
      { selector: { serviceTier: 'priority' }, rates: { input: 10, output: 60 } },
      { selector: { inputAboveTokens: 272000 }, rates: { input: 10, output: 45 } },
    ],
  };
  assertEquals(resolveEffectivePricing(pricing, 'priority', 272000), null);
  assertEquals(resolveEffectivePricing(pricing, 'batch', null), null);
  assertEquals(resolveEffectivePricing(pricing, null, 999), null);
  assertEquals(resolveEffectivePricing(null, null, null), null);
});

test('pricing resolution rejects duplicate coordinates deterministically', () => {
  const duplicateBase: ModelPricing = { cells: [{ rates: { input: 1 } }, { selector: {}, rates: { input: 2 } }] };
  assertThrows(() => resolveEffectivePricing(duplicateBase, null, null), Error, 'duplicate pricing cell coordinate');

  const duplicateCombined: ModelPricing = {
    cells: [
      { selector: { serviceTier: 'priority', inputAboveTokens: 272000 }, rates: { input: 1 } },
      { selector: { inputAboveTokens: 272000, serviceTier: 'priority' }, rates: { input: 2 } },
    ],
  };
  assertThrows(() => selectInputLengthTier(duplicateCombined, 300000), Error, 'duplicate pricing cell coordinate');
});

test('pricing resolution rejects malformed selectors deterministically', () => {
  assertThrows(
    () => resolveEffectivePricing({ cells: [{ selector: { serviceTier: '' }, rates: { input: 1 } }] }, null, null),
    RangeError,
    'pricing service-tier selector must be non-empty',
  );
  for (const inputAboveTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(
      () => selectInputLengthTier({ cells: [{ selector: { inputAboveTokens }, rates: { input: 2 } }] }, 300000),
      RangeError,
      'input-length pricing threshold must be a positive safe integer',
    );
  }
});
