import { test } from 'vitest';

import { pricingForCodexModelKey } from './pricing.ts';
import { resolveEffectivePricing } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

test('pricingForCodexModelKey resolves GPT-5.6 base, priority, and >272k long-context rates', () => {
  const sol = pricingForCodexModelKey('gpt-5.6-sol');
  assertEquals(sol, {
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 30,
    tiers: { priority: { input: 10, input_cache_read: 1, output: 60 } },
    inputLengthTiers: [{ minInputTokens: 272000, input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }],
  });

  // Base tier: cache-write is the published input × 1.25.
  assertEquals(resolveEffectivePricing(sol, null, null), { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 });

  // Priority (base length): the overlay omits cache-write, so it inherits the
  // base cache-write rate rather than the priority input rate.
  assertEquals(resolveEffectivePricing(sol, 'priority', null), { input: 10, input_cache_read: 1, input_cache_write: 6.25, output: 60 });

  // >272k full-request rate applies regardless of the service tier — no
  // separately-published priority×long-context combination exists.
  assertEquals(resolveEffectivePricing(sol, null, 272000), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 });
  assertEquals(resolveEffectivePricing(sol, 'priority', 272000), { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 });
});

test('pricingForCodexModelKey resolves the terra / luna >272k rates', () => {
  assertEquals(resolveEffectivePricing(pricingForCodexModelKey('gpt-5.6-terra'), null, 272000), { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 });
  assertEquals(resolveEffectivePricing(pricingForCodexModelKey('gpt-5.6-luna'), null, 272000), { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 });
});

test('pricingForCodexModelKey returns null for an unknown slug', () => {
  assertEquals(pricingForCodexModelKey('gpt-4.1'), null);
});
