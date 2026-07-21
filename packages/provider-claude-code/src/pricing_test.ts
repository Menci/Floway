import { describe, expect, test } from 'vitest';

import { pricingForClaudeCodeModelKey } from './pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

describe('pricingForClaudeCodeModelKey', () => {
  test('returns documented base rates for dated Opus and Fable', () => {
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'), { inputTokens: 0 }).rates).toEqual(published({ input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3.75', input_cache_write_1h_tokens: '6', output_tokens: '15' }));
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-5-20251101'), { inputTokens: 0 }).rates).toEqual(published({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', input_cache_write_1h_tokens: '10', output_tokens: '25' }));
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-sonnet-5'), { inputTokens: 0 }).rates).toEqual(published({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', input_cache_write_1h_tokens: '4', output_tokens: '10' }));
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-fable-5'), { inputTokens: 0 }).rates).toEqual(published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' }));
  });

  test('returns explicit fast entries for supported Opus models', () => {
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-8'), { serviceTier: 'fast', inputTokens: 0 }).rates).toEqual(published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' }));
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-7'), { serviceTier: 'fast', inputTokens: 0 }).rates).toEqual(published({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', input_cache_write_1h_tokens: '60', output_tokens: '150' }));
    expect(priceRequest(pricingForClaudeCodeModelKey('claude-opus-4-6'), { serviceTier: 'fast', inputTokens: 0 }).rates).toEqual(published({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', input_cache_write_1h_tokens: '60', output_tokens: '150' }));
  });

  test('returns null for the bare 4.5 alias, future dated snapshots, and unknown ids', () => {
    expect(pricingForClaudeCodeModelKey('claude-opus-4-5')).toBeNull();
    expect(pricingForClaudeCodeModelKey('claude-opus-4-5-20990101')).toBeNull();
    expect(pricingForClaudeCodeModelKey('claude-unknown')).toBeNull();
  });
});
