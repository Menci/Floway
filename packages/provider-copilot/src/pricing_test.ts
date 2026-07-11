import { test } from 'vitest';

import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import { resolveEffectivePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const OPUS_BASE = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 };

test('Copilot Claude pricing uses explicit base and fast cells', () => {
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('claude-opus-4-5'), null), OPUS_BASE);
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('claude-opus-4-5'), 'fast'), null);
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('claude-opus-4-7'), 'fast'), { input: 30, input_cache_read: 3, input_cache_write: 37.5, output: 150 });
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('claude-opus-4-8'), 'fast'), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 });
});

test('Copilot GPT-5.6 pricing resolves standard short and long cells', () => {
  const expected = {
    'gpt-5.6-sol': [
      { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
      { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 },
    ],
    'gpt-5.6-terra': [
      { input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 },
      { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 },
    ],
    'gpt-5.6-luna': [
      { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 },
      { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 },
    ],
  } as const;
  for (const [id, [short, long]] of Object.entries(expected)) {
    const pricing = pricingForCopilotPublicModelId(id);
    assertEquals(resolveEffectivePricing(pricing, null, null), short);
    assertEquals(resolveEffectivePricing(pricing, null, 272000), long);
  }
});

test('Copilot pricing resolves exact and regex model families', () => {
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('gpt-5.4'), null), { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('gpt-5.3-codex'), null), { input: 1.75, input_cache_read: 0.175, output: 14 });
  assertEquals(resolveEffectivePricing(pricingForCopilotPublicModelId('text-embedding-3-small'), null), { input: 0.02, output: 0 });
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
});

test('pricingForCopilotModelKey strips Claude variant suffixes before lookup', () => {
  for (const id of ['claude-opus-4-7-high', 'claude-opus-4-7-xhigh', 'claude-opus-4-7-1m', 'claude-opus-4-7-1m-internal', 'claude-opus-4-7-20251101']) {
    assertEquals(resolveEffectivePricing(pricingForCopilotModelKey(id), null), OPUS_BASE);
  }
  assertEquals(resolveEffectivePricing(pricingForCopilotModelKey('claude-opus-4-7-fast'), 'fast'), { input: 30, input_cache_read: 3, input_cache_write: 37.5, output: 150 });
});
