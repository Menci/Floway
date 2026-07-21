import { test } from 'vitest';

import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);
const OPUS_BASE = published({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' });

test('Copilot Claude pricing uses explicit base and fast entries', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { serviceTier: 'fast', inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-7'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', output_tokens: '150' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-8'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }));
});

test('Copilot GPT-5.6 pricing resolves standard short and long entries', () => {
  const expected = {
    'gpt-5.6-sol': [
      published({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '30' }),
      published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '45' }),
    ],
    'gpt-5.6-terra': [
      published({ input_tokens: '2.5', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.125', output_tokens: '15' }),
      published({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '22.5' }),
    ],
    'gpt-5.6-luna': [
      published({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', output_tokens: '6' }),
      published({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '9' }),
    ],
  } as const;
  for (const [id, [short, long]] of Object.entries(expected)) {
    const pricing = pricingForCopilotPublicModelId(id);
    assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, short);
    assertEquals(priceRequest(pricing, { inputTokens: 272000 + 1 }).rates, long);
  }
});

test('Copilot GPT and Gemini threshold entries apply whole-request rates', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.5'), { inputTokens: 272001 }).rates, published({ input_tokens: '10', input_cache_read_tokens: '1', output_tokens: '45' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 272001 }).rates, published({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '22.5' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gemini-3.1-pro-preview'), { inputTokens: 200001 }).rates, published({ input_tokens: '4', input_cache_read_tokens: '0.4', output_tokens: '18' }));
});

test('Copilot pricing resolves exact and regex model families', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 0 }).rates, published({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.3-codex'), { inputTokens: 0 }).rates, published({ input_tokens: '1.75', input_cache_read_tokens: '0.175', output_tokens: '14' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('text-embedding-3-small'), { inputTokens: 0 }).rates, published({ input_tokens: '0.02', output_tokens: '0' }));
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
});

test('pricingForCopilotModelKey strips Claude variant suffixes before lookup', () => {
  for (const id of ['claude-opus-4-7-high', 'claude-opus-4-7-xhigh', 'claude-opus-4-7-1m', 'claude-opus-4-7-1m-internal', 'claude-opus-4-7-20251101']) {
    assertEquals(priceRequest(pricingForCopilotModelKey(id), { inputTokens: 0 }).rates, OPUS_BASE);
  }
  assertEquals(priceRequest(pricingForCopilotModelKey('claude-opus-4-7-fast'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', output_tokens: '150' }));
});
