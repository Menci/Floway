import { test } from 'vitest';

import { pricingForCopilotPublicModelId } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);
const OPUS_BASE = published({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' });

test('Copilot Claude pricing uses explicit base and fast entries', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { serviceTier: 'fast', inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-7'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', output_tokens: '150' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-8'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-5'), { inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-5'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }));
});

test('Copilot GPT-5.6 pricing resolves standard short and long entries', () => {
  const expected = {
    'gpt-5.6-sol': [
      published({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '20' }),
      published({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '30' }),
    ],
    'gpt-5.6-terra': [
      published({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '12' }),
      published({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '18' }),
    ],
    'gpt-5.6-luna': [
      published({ input_tokens: '0.2', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25', output_tokens: '1.2' }),
      published({ input_tokens: '0.4', input_cache_read_tokens: '0.04', input_cache_write_tokens: '0.5', output_tokens: '1.8' }),
    ],
  } as const;
  for (const [id, [short, long]] of Object.entries(expected)) {
    const pricing = pricingForCopilotPublicModelId(id);
    assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, short);
    assertEquals(priceRequest(pricing, { inputTokens: 272000 + 1 }).rates, long);
  }
});

test('Copilot GPT-5.6 Sol prices its accelerated lane on the served priority tier', () => {
  const pricing = pricingForCopilotPublicModelId('gpt-5.6-sol');
  assertEquals(
    priceRequest(pricing, { serviceTier: 'priority', inputTokens: 0 }).rates,
    published({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '40' }),
  );
  assertEquals(
    priceRequest(pricing, { serviceTier: 'priority', inputTokens: 272000 + 1 }).rates,
    published({ input_tokens: '16', input_cache_read_tokens: '1.6', input_cache_write_tokens: '20', output_tokens: '60' }),
  );
});

// The lane is reachable only on models that publish a `-fast` raw variant; the
// rest fall back to their standard rates rather than inventing a tier.
test('Copilot GPT-5.6 Terra falls back to its standard rates on a priority tier', () => {
  assertEquals(
    priceRequest(pricingForCopilotPublicModelId('gpt-5.6-terra'), { serviceTier: 'priority', inputTokens: 0 }).rates,
    published({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '12' }),
  );
});

test('Copilot GPT and Gemini threshold entries apply whole-request rates', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.5'), { inputTokens: 272001 }).rates, published({ input_tokens: '10', input_cache_read_tokens: '1', output_tokens: '45' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 272001 }).rates, published({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '22.5' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gemini-3.1-pro-preview'), { inputTokens: 200001 }).rates, published({ input_tokens: '4', input_cache_read_tokens: '0.4', output_tokens: '18' }));
});

test('Copilot Grok 4.5 long-context band starts at the 200k prompt itself', () => {
  const pricing = pricingForCopilotPublicModelId('grok-4.5');
  const short = published({ input_tokens: '2', input_cache_read_tokens: '0.3', output_tokens: '6' });
  assertEquals(priceRequest(pricing, { inputTokens: 199999 }).rates, short);
  assertEquals(priceRequest(pricing, { inputTokens: 200000 }).rates, published({ input_tokens: '4', input_cache_read_tokens: '0.6', output_tokens: '12' }));
});

test('Copilot Gemini 3.6, 3.7 and 3.8 Flash share one rate across every prompt length', () => {
  const base = published({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '3.75' });
  for (const id of ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
    const pricing = pricingForCopilotPublicModelId(id);
    assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, base);
    assertEquals(priceRequest(pricing, { inputTokens: 936000 }).rates, base);
  }
  // 3.5 Flash is not swept up by the shared rule.
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gemini-3.5-flash'), { inputTokens: 0 }).rates, published({ input_tokens: '1.5', input_cache_read_tokens: '0.15', output_tokens: '9' }));
});

test('Copilot pricing resolves exact and regex model families', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 0 }).rates, published({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.3-codex'), { inputTokens: 0 }).rates, published({ input_tokens: '1.75', input_cache_read_tokens: '0.175', output_tokens: '14' }));
  assertEquals(priceRequest(pricingForCopilotPublicModelId('text-embedding-3-small'), { inputTokens: 0 }).rates, published({ input_tokens: '0.02', output_tokens: '0' }));
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
  // Copilot's hidden compaction model has no vendor SKU to price against.
  assertEquals(pricingForCopilotPublicModelId('trajectory-compaction'), null);
});

test('Copilot prices the models added to the live catalog since the last refresh', () => {
  const rates = (id: string) => priceRequest(pricingForCopilotPublicModelId(id), { inputTokens: 0 }).rates;
  const longRates = (id: string, threshold: number) => priceRequest(pricingForCopilotPublicModelId(id), { inputTokens: threshold + 1 }).rates;

  assertEquals(rates('grok-4.6'), published({ input_tokens: '2', input_cache_read_tokens: '0.5', output_tokens: '6' }));
  assertEquals(longRates('grok-4.6', 199999), published({ input_tokens: '4', input_cache_read_tokens: '1', output_tokens: '12' }));
  // 4.5 keeps the lower cached-read rate xAI publishes for it.
  assertEquals(rates('grok-4.5'), published({ input_tokens: '2', input_cache_read_tokens: '0.3', output_tokens: '6' }));

  assertEquals(rates('mai-code-1.1-flash'), published({ input_tokens: '0.2', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25', output_tokens: '1.2' }));
  // The 1-Flash prefix rule must not swallow the dotted 1.1 id.
  assertEquals(rates('mai-code-1-flash-picker'), published({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '4.5' }));
});

test('Copilot GPT-6 Astra prices the standard short and long bands its catalog serves', () => {
  const pricing = pricingForCopilotPublicModelId('gpt-6-astra');
  assertEquals(
    priceRequest(pricing, { inputTokens: 272000 }).rates,
    published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }),
  );
  assertEquals(
    priceRequest(pricing, { inputTokens: 272001 }).rates,
    published({ input_tokens: '20', input_cache_read_tokens: '2', input_cache_write_tokens: '25', output_tokens: '75' }),
  );
  // Copilot publishes no accelerated Astra sibling and reports `default`, so
  // an unserved tier falls back to Base rather than gaining an invented rate.
  assertEquals(
    priceRequest(pricing, { serviceTier: 'priority', inputTokens: 0 }).rates,
    published({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }),
  );
});
