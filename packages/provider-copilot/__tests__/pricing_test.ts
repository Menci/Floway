import { test } from 'vitest';

import { pricingForCopilotPublicModelId } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('Copilot pricing resolves exact and regex model families', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 0 }).rates, published({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.3-codex'), { inputTokens: 0 }).rates, published({ input_tokens: '1.75', input_cache_read_tokens: '0.175', output_tokens: '14' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('text-embedding-3-small'), { inputTokens: 0 }).rates, published({ input_tokens: '0.02', output_tokens: '0' }));
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
  // Copilot's hidden compaction model has no vendor SKU to price against.
  assertEquals(pricingForCopilotPublicModelId('trajectory-compaction'), null);
});
