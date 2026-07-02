import { test } from 'vitest';

import { resolveEffectivePricing, unitPriceForDimension, type ModelPricing } from './models.ts';
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
