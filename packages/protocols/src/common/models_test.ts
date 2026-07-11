import { test } from 'vitest';

import { resolveEffectivePricing, selectInputLengthTier, unitPriceForDimension, type ModelPricing } from './models.ts';
import { assertEquals } from '../test-assert.ts';

test('unitPriceForDimension returns null when pricing snapshot is null', () => {
  assertEquals(unitPriceForDimension(null, 'input'), null);
  assertEquals(unitPriceForDimension(null, 'input_cache_write_1h'), null);
});

test('unitPriceForDimension prefers the dimension-specific rate', () => {
  const pricing = { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_cache_write_1h: 2, output: 5 };
  assertEquals(unitPriceForDimension(pricing, 'input'), 1);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_read'), 0.1);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write'), 1.25);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 2);
  assertEquals(unitPriceForDimension(pricing, 'output'), 5);
});

test('unitPriceForDimension falls input_cache_write_1h back to input_cache_write before reaching input', () => {
  // 1h -> 5m -> input. When only 5m is defined, 1h reuses the 5m rate
  // rather than skipping straight to the bare input rate.
  const pricing = { input: 1, input_cache_write: 1.25 };
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 1.25);
});

test('unitPriceForDimension falls input_cache_write_1h all the way back to input when neither cache write is set', () => {
  const pricing = { input: 1 };
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 1);
});

test('unitPriceForDimension returns null when the fallback chain is empty', () => {
  assertEquals(unitPriceForDimension({}, 'input_cache_write_1h'), null);
  assertEquals(unitPriceForDimension({ output: 5 }, 'input_cache_write_1h'), null);
});

test('resolveEffectivePricing merges a tier override into the base snapshot and strips tiers', () => {
  const base: ModelPricing = {
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
    tiers: { fast: { input: 30, output: 150, input_cache_write: 60 } },
  };
  const effective = resolveEffectivePricing(base, 'fast');
  assertEquals(effective, {
    input: 30,
    input_cache_read: 0.5,
    input_cache_write: 60,
    output: 150,
  });
});

test('resolveEffectivePricing shallow-merges per dimension — omitted overlay keys inherit the base rate', () => {
  // The codex flex/priority overlays exploit this: they declare only the
  // input/output/cache-read dimensions that differ at the tier and leave
  // cache-write (and any 1h/image dimension) to inherit base.
  const base: ModelPricing = {
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
    tiers: { flex: { input: 2.5 } },
  };
  assertEquals(resolveEffectivePricing(base, 'flex'), {
    input: 2.5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
  });
});

test('resolveEffectivePricing returns the base snapshot (sans tiers) when tier is unknown or absent', () => {
  const base: ModelPricing = {
    input: 5,
    output: 25,
    tiers: { fast: { input: 30 } },
  };
  const expected: ModelPricing = { input: 5, output: 25 };

  assertEquals(resolveEffectivePricing(base, null), expected);
  assertEquals(resolveEffectivePricing(base, undefined), expected);
  assertEquals(resolveEffectivePricing(base, 'priority'), expected);
});

test('resolveEffectivePricing returns null when the base snapshot is null', () => {
  assertEquals(resolveEffectivePricing(null, 'fast'), null);
  assertEquals(resolveEffectivePricing(null, null), null);
});

test('resolveEffectivePricing folds an empty overlay to the base snapshot', () => {
  // Operators who don't track per-tier billing (or upstreams where every tier
  // prices identically) declare `tiers.foo = {}` to acknowledge the tier
  // without any rate change.
  const base: ModelPricing = {
    input: 5,
    output: 25,
    tiers: { priority: {} },
  };
  assertEquals(resolveEffectivePricing(base, 'priority'), { input: 5, output: 25 });
});

const gpt56Sol: ModelPricing = {
  input: 5,
  input_cache_read: 0.5,
  input_cache_write: 6.25,
  output: 30,
  tiers: { priority: { input: 10, input_cache_read: 1, output: 60 } },
  inputLengthTiers: [{ minInputTokens: 272000, input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }],
};

test('selectInputLengthTier returns the marker only once the disjoint input total crosses the threshold', () => {
  assertEquals(selectInputLengthTier(gpt56Sol, 271999), null);
  assertEquals(selectInputLengthTier(gpt56Sol, 272000), 272000);
  assertEquals(selectInputLengthTier(gpt56Sol, 500000), 272000);
});

test('selectInputLengthTier returns null when the model declares no input-length tiers', () => {
  assertEquals(selectInputLengthTier({ input: 5, output: 25 }, 1_000_000), null);
  assertEquals(selectInputLengthTier(null, 1_000_000), null);
});

test('selectInputLengthTier picks the highest threshold a request meets', () => {
  const tiered: ModelPricing = {
    input: 1,
    inputLengthTiers: [
      { minInputTokens: 128000, input: 2 },
      { minInputTokens: 512000, input: 4 },
    ],
  };
  assertEquals(selectInputLengthTier(tiered, 100000), null);
  assertEquals(selectInputLengthTier(tiered, 200000), 128000);
  assertEquals(selectInputLengthTier(tiered, 600000), 512000);
});

test('resolveEffectivePricing applies the input-length tier over base and strips both tier maps', () => {
  assertEquals(resolveEffectivePricing(gpt56Sol, null, 272000), {
    input: 10,
    input_cache_read: 1,
    input_cache_write: 12.5,
    output: 45,
  });
});

test('resolveEffectivePricing lets a complete input-length tier win over the service tier (documented default)', () => {
  // A priority request that is also >272k has no separately-published combined
  // rate, so the full-request long-context rate applies rather than stacking a
  // priority multiplier on top of it.
  assertEquals(resolveEffectivePricing(gpt56Sol, 'priority', 272000), {
    input: 10,
    input_cache_read: 1,
    input_cache_write: 12.5,
    output: 45,
  });
});

test('resolveEffectivePricing composes service tier with a partial input-length tier per dimension', () => {
  // The input-length tier names only output, so the service-tier input rate
  // survives for the input dimension it does not touch.
  const partial: ModelPricing = {
    input: 5,
    output: 30,
    tiers: { priority: { input: 10, output: 60 } },
    inputLengthTiers: [{ minInputTokens: 272000, output: 45 }],
  };
  assertEquals(resolveEffectivePricing(partial, 'priority', 272000), { input: 10, output: 45 });
});

test('resolveEffectivePricing honors an explicit (service x input-length) combination', () => {
  const explicit: ModelPricing = {
    input: 5,
    output: 30,
    tiers: { priority: { input: 10, output: 60 } },
    inputLengthTiers: [{ minInputTokens: 272000, input: 10, output: 45, tiers: { priority: { input: 20, output: 90 } } }],
  };
  assertEquals(resolveEffectivePricing(explicit, 'priority', 272000), { input: 20, output: 90 });
  // A base-tier >272k request still uses the plain long-context rate.
  assertEquals(resolveEffectivePricing(explicit, null, 272000), { input: 10, output: 45 });
});

test('resolveEffectivePricing ignores an input-length marker with no matching tier', () => {
  assertEquals(resolveEffectivePricing(gpt56Sol, null, 999999), {
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 30,
  });
});
