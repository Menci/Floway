import { test } from 'vitest';

import { pricingForChatGPTModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('ChatGPT Daybreak slugs price the models their access programs resolve to', () => {
  // Blue is the GPT-5.6 Sol program, Red the GPT-5.6 Cyber one. Neither slug
  // advertises a service tier, so a priority selector stays on the base rates
  // rather than inheriting the Fast lane its underlying model sells elsewhere.
  const blue = pricingForChatGPTModelKey('gpt-daybreak-blue-latest');
  assertEquals(priceRequest(blue, { inputTokens: 272000 }).rates, published({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '20' }));
  assertEquals(priceRequest(blue, { inputTokens: 272001 }).rates, published({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '30' }));
  assertEquals(priceRequest(blue, { serviceTier: 'priority', inputTokens: 0 }).rates, published({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '20' }));

  const cyber = published({ input_tokens: '12.5', input_cache_read_tokens: '1.25', input_cache_write_tokens: '15.625', output_tokens: '75' });
  const red = pricingForChatGPTModelKey('gpt-daybreak-red-latest');
  assertEquals(priceRequest(red, { inputTokens: 0 }).rates, cyber);
  // OpenAI's cyber card publishes no long-context band.
  assertEquals(priceRequest(red, { inputTokens: 372001 }).rates, cyber);
});
