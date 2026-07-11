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

// A full (service tier × input length) grid: standard/priority × short/long,
// modeled after GPT-5.6 Sol.
const GRID: ModelPricing = {
  input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30,
  tiers: { priority: { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 } },
  inputLengthTiers: [{
    aboveInputTokens: 272000,
    input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45,
    tiers: { priority: { input: 20, input_cache_read: 2, input_cache_write: 25, output: 90 } },
  }],
};

test('selectInputLengthTier treats the threshold as strictly-greater: 272000 stays short, 272001 is long', () => {
  assertEquals(selectInputLengthTier(GRID, 271999), null);
  assertEquals(selectInputLengthTier(GRID, 272000), null);
  assertEquals(selectInputLengthTier(GRID, 272001), 272000);
});

test('selectInputLengthTier returns null when the model declares no input-length bands', () => {
  assertEquals(selectInputLengthTier({ input: 5 }, 10_000_000), null);
  assertEquals(selectInputLengthTier(null, 10_000_000), null);
});

test('selectInputLengthTier picks the highest band the request exceeds', () => {
  const pricing: ModelPricing = {
    input: 1,
    inputLengthTiers: [
      { aboveInputTokens: 128000, input: 2 },
      { aboveInputTokens: 272000, input: 4 },
    ],
  };
  assertEquals(selectInputLengthTier(pricing, 128000), null);
  assertEquals(selectInputLengthTier(pricing, 128001), 128000);
  assertEquals(selectInputLengthTier(pricing, 272001), 272000);
});

test('resolveEffectivePricing resolves each Cartesian cell of the grid to its explicit rates', () => {
  // (standard, short) — the base cell.
  assertEquals(resolveEffectivePricing(GRID, null, null), { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 });
  // (priority, short) — the base-length service cell.
  assertEquals(resolveEffectivePricing(GRID, 'priority', null), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 });
  // (standard, long) — the input-length band's default-tier rates.
  assertEquals(resolveEffectivePricing(GRID, null, 272000), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 });
  // (priority, long) — the explicit combined cell, not a silent single-axis win.
  assertEquals(resolveEffectivePricing(GRID, 'priority', 272000), { input: 20, input_cache_read: 2, input_cache_write: 25, output: 90 });
});

test('resolveEffectivePricing returns null when both selectors are non-default but the combined cell is missing', () => {
  // The model prices `priority` at base length and prices a long band, but
  // publishes no priority-long cell. Rather than let one axis silently win or
  // multiply the two, the (priority, long) request is unpriced.
  const partialGrid: ModelPricing = {
    input: 5, output: 30,
    tiers: { priority: { input: 10, output: 60 } },
    inputLengthTiers: [{ aboveInputTokens: 272000, input: 10, output: 45 }],
  };
  assertEquals(resolveEffectivePricing(partialGrid, 'priority', 272000), null);
  // Each single-axis cell is still priced.
  assertEquals(resolveEffectivePricing(partialGrid, 'priority', null), { input: 10, output: 60 });
  assertEquals(resolveEffectivePricing(partialGrid, null, 272000), { input: 10, output: 45 });
});

test('resolveEffectivePricing prices an unrecognized service tier at the long band as the standard-long cell', () => {
  // An unknown/absent service tier is not a non-default selector — only the
  // input length is — so a long request resolves to the standard-long cell.
  assertEquals(resolveEffectivePricing(GRID, 'batch', 272000), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 });
});

test('resolveEffectivePricing ignores an input-length coordinate that names no declared band', () => {
  // A stored coordinate that matches no band (e.g. a band removed from the
  // table after the row was written) selects no input-length cell.
  assertEquals(resolveEffectivePricing(GRID, null, 999), { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 });
  assertEquals(resolveEffectivePricing(GRID, 'priority', 999), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 });
});
