import { test } from 'vitest';

import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import { assertEquals } from '@floway-dev/test-utils';

const OPUS_BASE = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 };
const OPUS_FAST_TIER_6X = { input: 30, input_cache_read: 3, input_cache_write: 37.5, output: 150 };
const OPUS_FAST_TIER_2X = { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 };

test('pricingForCopilotPublicModelId resolves Opus 4.5 with no fast tier (no -fast variant in catalog)', () => {
  assertEquals(pricingForCopilotPublicModelId('claude-opus-4-5'), OPUS_BASE);
});

test('pricingForCopilotPublicModelId resolves Opus 4.6 / 4.7 with 6x Fast Mode tier', () => {
  const opus = { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_6X } };
  assertEquals(pricingForCopilotPublicModelId('claude-opus-4-6'), opus);
  assertEquals(pricingForCopilotPublicModelId('claude-opus-4-7'), opus);
});

test('pricingForCopilotPublicModelId resolves Opus 4.8 with 2x Fast Mode tier', () => {
  assertEquals(pricingForCopilotPublicModelId('claude-opus-4-8'), { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_2X } });
});

test('pricingForCopilotPublicModelId resolves Claude sonnet/haiku families', () => {
  assertEquals(pricingForCopilotPublicModelId('claude-sonnet-4-5'), { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 });
  assertEquals(pricingForCopilotPublicModelId('claude-haiku-4-5'), { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 });
});

test('pricingForCopilotPublicModelId resolves gpt-5 family by exact id and regex', () => {
  assertEquals(pricingForCopilotPublicModelId('gpt-5.4'), { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(pricingForCopilotPublicModelId('gpt-5.3-codex'), { input: 1.75, input_cache_read: 0.175, output: 14 });
  assertEquals(pricingForCopilotPublicModelId('gpt-5.1-codex-mini'), { input: 0.25, input_cache_read: 0.025, output: 2 });
});

test('pricingForCopilotPublicModelId resolves embeddings with output 0', () => {
  assertEquals(pricingForCopilotPublicModelId('text-embedding-3-small'), { input: 0.02, output: 0 });
  assertEquals(pricingForCopilotPublicModelId('text-embedding-ada-002'), { input: 0.1, output: 0 });
});

test('pricingForCopilotPublicModelId resolves gpt-5.6 family with a standard short/long input-length grid', () => {
  assertEquals(pricingForCopilotPublicModelId('gpt-5.6-sol'), {
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30,
    inputLengthTiers: [{ aboveInputTokens: 272000, input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }],
  });
  assertEquals(pricingForCopilotPublicModelId('gpt-5.6-terra'), {
    input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15,
    inputLengthTiers: [{ aboveInputTokens: 272000, input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 }],
  });
  assertEquals(pricingForCopilotPublicModelId('gpt-5.6-luna'), {
    input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6,
    inputLengthTiers: [{ aboveInputTokens: 272000, input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 }],
  });
});

test('pricingForCopilotPublicModelId returns null for unknown ids', () => {
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
});

test('pricingForCopilotModelKey strips Claude variant suffix before lookup', () => {
  const opus = { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_6X } };
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-high'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-xhigh'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-1m'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-1m-internal'), opus);
});

test('pricingForCopilotModelKey strips -fast suffix and resolves to the base-with-fast-tier entry', () => {
  // The raw `-fast` variant is the wire id Copilot serves; pricing is keyed
  // on the merged public id and the `tier='fast'` marker (set from
  // `usage.speed='fast'`) selects the override at billing time.
  assertEquals(pricingForCopilotModelKey('claude-opus-4-6-fast'), { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_6X } });
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-fast'), { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_6X } });
  assertEquals(pricingForCopilotModelKey('claude-opus-4-8-fast'), { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_2X } });
});

test('pricingForCopilotModelKey strips trailing date suffix on Claude variants', () => {
  const opus = { ...OPUS_BASE, tiers: { fast: OPUS_FAST_TIER_6X } };
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-20251101'), opus);
  assertEquals(pricingForCopilotModelKey('claude-opus-4-7-xhigh-20251101'), opus);
});

test('pricingForCopilotModelKey passes non-Claude ids through unchanged', () => {
  assertEquals(pricingForCopilotModelKey('gpt-5.4'), { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(pricingForCopilotModelKey('gpt-4o'), { input: 2.5, input_cache_read: 1.25, output: 10 });
});
