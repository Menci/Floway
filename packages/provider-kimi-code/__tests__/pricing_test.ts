import { describe, expect, test } from 'vitest';

import { pricingForKimiCodePublicModelId } from '../src/pricing.ts';
import { collectModelPricingIssues, perMillionTokenRates, priceRequest } from '@floway-dev/protocols/common';

describe('pricingForKimiCodePublicModelId', () => {
  test.each([
    // K3.1, K3 and K2.7 use published API rates.
    // https://platform.kimi.ai/docs/pricing/chat
    ['kimi-k3.1-pro', { input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2', input_cache_write_1h_tokens: '4', output_tokens: '10' }],
    ['kimi-k3', { input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3', input_cache_write_1h_tokens: '6', output_tokens: '15' }],
    ['kimi-k2.7-code', { input_tokens: '0.95', input_cache_read_tokens: '0.19', output_tokens: '4' }],
    // K2.8 has no published equivalent; its values were supplied by the operator.
    ['kimi-k2.8-preview', { input_tokens: '0.95', input_cache_read_tokens: '0.25', output_tokens: '4' }],
  ] as const)('returns API-equivalent Base rates per token for %s', (id, rates) => {
    const pricing = pricingForKimiCodePublicModelId(id)!;
    expect(collectModelPricingIssues(pricing)).toEqual([]);
    expect(priceRequest(pricing, { inputTokens: 0 }).rates).toEqual(perMillionTokenRates(rates));
    expect(priceRequest(pricing, { inputTokens: 1_048_576, serviceTier: 'unpublished-tier' }).rates).toEqual(perMillionTokenRates(rates));
  });

  // https://platform.kimi.ai/docs/pricing/chat
  test.each(['priority', 'fast'])('prices K3.1 Pro %s at double I/O and writes while keeping cache reads unchanged', serviceTier => {
    expect(priceRequest(pricingForKimiCodePublicModelId('kimi-k3.1-pro'), { serviceTier }).rates).toEqual(perMillionTokenRates({
      input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '4', input_cache_write_1h_tokens: '8', output_tokens: '20',
    }));
  });

  // https://platform.kimi.ai/docs/pricing/chat
  test.each(['priority', 'fast'])('prices K2.7 Code %s at double every published metric without inventing write rates', serviceTier => {
    expect(priceRequest(pricingForKimiCodePublicModelId('kimi-k2.7-code'), { serviceTier }).rates).toEqual(perMillionTokenRates({
      input_tokens: '1.9', input_cache_read_tokens: '0.38', output_tokens: '8',
    }));
  });

  test.each(['priority', 'fast'])('prices K2.8 Preview %s at double every supplied metric without inventing write rates', serviceTier => {
    expect(priceRequest(pricingForKimiCodePublicModelId('kimi-k2.8-preview'), { serviceTier }).rates).toEqual(perMillionTokenRates({
      input_tokens: '1.9', input_cache_read_tokens: '0.5', output_tokens: '8',
    }));
  });

  test.each(['priority', 'fast'])('prices the unpublished K3 accelerated lane %s at double every metric', serviceTier => {
    expect(priceRequest(pricingForKimiCodePublicModelId('kimi-k3'), { serviceTier }).rates).toEqual(perMillionTokenRates({
      input_tokens: '6', input_cache_read_tokens: '0.6', input_cache_write_tokens: '6', input_cache_write_1h_tokens: '12', output_tokens: '30',
    }));
  });

  test.each(['kimi-k3-256k', 'kimi-k3.1-pro-future', 'kimi-k3.1-pro-highspeed', 'kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'unknown'])('leaves withheld variants and non-public identities unpriced: %s', id => {
    expect(pricingForKimiCodePublicModelId(id)).toBeNull();
    expect(priceRequest(pricingForKimiCodePublicModelId(id), { serviceTier: 'priority' }).rates).toBeNull();
  });
});
