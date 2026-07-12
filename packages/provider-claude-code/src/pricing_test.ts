import { describe, expect, test } from 'vitest';

import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { priceRequest } from '@floway-dev/protocols/common';

describe('pricingForClaudeCodeModelKey', () => {
  test('returns documented base rates for dated Opus and Fable', () => {
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'), { inputTokens: 0 }).rates).toEqual({ input: 3, input_cache_read: 0.3, input_cache_write: 3.75, input_cache_write_1h: 6, output: 15 });
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-5-20251101'), { inputTokens: 0 }).rates).toEqual({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, input_cache_write_1h: 10, output: 25 });
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-sonnet-5'), { inputTokens: 0 }).rates).toEqual({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, input_cache_write_1h: 4, output: 10 });
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-fable-5'), { inputTokens: 0 }).rates).toEqual({ input: 10, input_cache_read: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 });
  });

  test('returns explicit fast entries for supported Opus models', () => {
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-8'), { serviceTier: 'fast', inputTokens: 0 }).rates).toEqual({ input: 10, input_cache_read: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 });
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-7'), { serviceTier: 'fast', inputTokens: 0 }).rates).toEqual({ input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 });
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-6'), { serviceTier: 'fast', inputTokens: 0 }).rates).toEqual({ input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 });
  });

  test('returns null for the bare 4.5 alias, future dated snapshots, and unknown ids', () => {
    expect(pricingForClaudeCodeModelKey('claude-opus-4-5')).toBeNull();
    expect(pricingForClaudeCodeModelKey('claude-opus-4-5-20990101')).toBeNull();
    expect(pricingForClaudeCodeModelKey('claude-unknown')).toBeNull();
  });
});
