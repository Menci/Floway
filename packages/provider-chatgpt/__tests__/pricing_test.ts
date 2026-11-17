import { test } from 'vitest';

import { pricingForChatGPTModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('ChatGPT gpt-5.4 and gpt-5.4-mini keep their explicit flex and priority entries', () => {
  const gpt54 = pricingForChatGPTModelKey('gpt-5.4');
  assertEquals(priceRequest(gpt54, { serviceTier: 'flex', inputTokens: 0 }).rates, published({ input_tokens: '1.25', input_cache_read_tokens: '0.13', output_tokens: '7.5' }));
  assertEquals(priceRequest(gpt54, { serviceTier: 'priority', inputTokens: 0 }).rates, published({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '30' }));
  assertEquals(priceRequest(gpt54, { inputTokens: 272001 }).rates, published({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '22.5' }));
  assertEquals(priceRequest(gpt54, { serviceTier: 'priority', inputTokens: 272001 }).rates, published({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }));
  assertEquals(priceRequest(gpt54, { serviceTier: 'flex', inputTokens: 272001 }).rates, published({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }));

  const mini = pricingForChatGPTModelKey('gpt-5.4-mini');
  assertEquals(priceRequest(mini, { inputTokens: 0 }).rates, published({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '4.5' }));
  assertEquals(priceRequest(mini, { serviceTier: 'flex', inputTokens: 0 }).rates, published({ input_tokens: '0.375', input_cache_read_tokens: '0.0375', output_tokens: '2.25' }));
  assertEquals(priceRequest(mini, { serviceTier: 'priority', inputTokens: 0 }).rates, published({ input_tokens: '1.5', input_cache_read_tokens: '0.15', output_tokens: '9' }));
});

test('pricingForChatGPTModelKey returns null for an unknown slug', () => {
  assertEquals(pricingForChatGPTModelKey('totally-made-up-model'), null);
});

test('ChatGPT GPT-6.2 Astra and Sol resolve Standard, Fast and promotional Ultrafast in both context bands', () => {
  const cases = {
    'gpt-6.2-astra': [
      [{ inputTokens: 272000 }, { input_tokens: '8', input_cache_read_tokens: '0.4', input_cache_write_tokens: '10', output_tokens: '40' }],
      [{ inputTokens: 272001 }, { input_tokens: '16', input_cache_read_tokens: '0.8', input_cache_write_tokens: '20', output_tokens: '60' }],
      [{ serviceTier: 'priority', inputTokens: 272000 }, { input_tokens: '16', input_cache_read_tokens: '0.8', input_cache_write_tokens: '20', output_tokens: '80' }],
      [{ serviceTier: 'priority', inputTokens: 272001 }, { input_tokens: '32', input_cache_read_tokens: '1.6', input_cache_write_tokens: '40', output_tokens: '120' }],
      [{ serviceTier: 'ultrafast', inputTokens: 272000 }, { input_tokens: '24', input_cache_read_tokens: '1.2', input_cache_write_tokens: '30', output_tokens: '120' }],
      [{ serviceTier: 'ultrafast', inputTokens: 272001 }, { input_tokens: '48', input_cache_read_tokens: '2.4', input_cache_write_tokens: '60', output_tokens: '180' }],
      // OpenAI publishes no Flex rate for GPT-6.2, so the lane falls back to Base.
      [{ serviceTier: 'flex', inputTokens: 0 }, { input_tokens: '8', input_cache_read_tokens: '0.4', input_cache_write_tokens: '10', output_tokens: '40' }],
    ],
    'gpt-6.2-sol': [
      [{ inputTokens: 272000 }, { input_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '2.5', output_tokens: '10' }],
      [{ inputTokens: 272001 }, { input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '5', output_tokens: '15' }],
      [{ serviceTier: 'priority', inputTokens: 272000 }, { input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '5', output_tokens: '20' }],
      [{ serviceTier: 'priority', inputTokens: 272001 }, { input_tokens: '8', input_cache_read_tokens: '0.4', input_cache_write_tokens: '10', output_tokens: '30' }],
      [{ serviceTier: 'ultrafast', inputTokens: 272000 }, { input_tokens: '6', input_cache_read_tokens: '0.3', input_cache_write_tokens: '7.5', output_tokens: '30' }],
      [{ serviceTier: 'ultrafast', inputTokens: 272001 }, { input_tokens: '12', input_cache_read_tokens: '0.6', input_cache_write_tokens: '15', output_tokens: '45' }],
      [{ serviceTier: 'flex', inputTokens: 0 }, { input_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '2.5', output_tokens: '10' }],
    ],
  } as const;

  for (const [id, grid] of Object.entries(cases)) {
    const pricing = pricingForChatGPTModelKey(id);
    for (const [facts, rates] of grid) assertEquals(priceRequest(pricing, facts).rates, published(rates));
  }
});

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
