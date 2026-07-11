import { describe, expect, test } from 'vitest';

import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { resolveEffectivePricing } from '@floway-dev/protocols/common';

describe('pricingForClaudeCodeModelKey', () => {
  test('returns documented base rates', () => {
    expect(resolveEffectivePricing(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'), null)).toEqual({ input: 3, input_cache_read: 0.3, input_cache_write: 3.75, input_cache_write_1h: 6, output: 15 });
    expect(resolveEffectivePricing(pricingForClaudeCodeModelKey('claude-opus-4-5-20251101'), null)).toEqual({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, input_cache_write_1h: 10, output: 25 });
    expect(resolveEffectivePricing(pricingForClaudeCodeModelKey('claude-sonnet-5'), null)).toEqual({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, input_cache_write_1h: 4, output: 10 });
  });

  test('returns explicit fast cells for supported Opus models', () => {
    expect(resolveEffectivePricing(pricingForClaudeCodeModelKey('claude-opus-4-8'), 'fast')).toEqual({ input: 10, input_cache_read: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 });
    expect(resolveEffectivePricing(pricingForClaudeCodeModelKey('claude-opus-4-7'), 'fast')).toEqual({ input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 });
    expect(resolveEffectivePricing(pricingForClaudeCodeModelKey('claude-opus-4-6'), 'fast')).toEqual({ input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 });
  });

  test('returns null for unknown ids', () => {
    expect(pricingForClaudeCodeModelKey('claude-unknown')).toBeNull();
  });
});
