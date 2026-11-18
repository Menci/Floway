import { describe, expect, test } from 'vitest';

import { pricingForClaudeCodeModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

describe('pricingForClaudeCodeModelKey', () => {
  test('prices Haiku 5.5 on both sides of its 100k input-token boundary', () => {
    const pricing = pricingForClaudeCodeModelKey('claude-haiku-5-5');
    expect(priceRequest(pricing, { inputTokens: 100000 }).rates).toEqual(published({ input_tokens: '0.1', input_cache_read_tokens: '0.01', input_cache_write_tokens: '0.125', input_cache_write_1h_tokens: '0.2', output_tokens: '0.5' }));
    expect(priceRequest(pricing, { inputTokens: 100001 }).rates).toEqual(published({ input_tokens: '0.5', input_cache_read_tokens: '0.05', input_cache_write_tokens: '0.625', input_cache_write_1h_tokens: '1', output_tokens: '2.5' }));
  });
});
