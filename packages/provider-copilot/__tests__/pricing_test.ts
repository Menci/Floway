import { test } from 'vitest';

import { pricingForCopilotPublicModelId } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);
const OPUS_BASE = published({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' });

test('Copilot Claude pricing uses explicit base and fast entries', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { serviceTier: 'fast', inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-7'), { serviceTier: 'fast', inputTokens: 0 }).rates, published({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', output_tokens: '150' }));
});

test('Copilot Haiku 5.5 pricing switches above 100k input tokens', () => {
  const pricing = pricingForCopilotPublicModelId('claude-haiku-5-5');
  assertEquals(
    priceRequest(pricing, { inputTokens: 100000 }).rates,
    published({ input_tokens: '0.1', input_cache_read_tokens: '0.01', input_cache_write_tokens: '0.125', output_tokens: '0.5' }),
  );
  assertEquals(
    priceRequest(pricing, { inputTokens: 100001 }).rates,
    published({ input_tokens: '0.5', input_cache_read_tokens: '0.05', input_cache_write_tokens: '0.625', output_tokens: '2.5' }),
  );
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

test('Copilot GPT-6.2 Astra and Sol price API Standard and the anticipated Fast lanes only', () => {
  const cases = {
    'gpt-6.2-astra': {
      standardShort: { input_tokens: '8', input_cache_read_tokens: '0.4', input_cache_write_tokens: '10', output_tokens: '40' },
      standardLong: { input_tokens: '16', input_cache_read_tokens: '0.8', input_cache_write_tokens: '20', output_tokens: '60' },
      priorityShort: { input_tokens: '16', input_cache_read_tokens: '0.8', input_cache_write_tokens: '20', output_tokens: '80' },
      priorityLong: { input_tokens: '32', input_cache_read_tokens: '1.6', input_cache_write_tokens: '40', output_tokens: '120' },
    },
    'gpt-6.2-sol': {
      standardShort: { input_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '2.5', output_tokens: '10' },
      standardLong: { input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '5', output_tokens: '15' },
      priorityShort: { input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '5', output_tokens: '20' },
      priorityLong: { input_tokens: '8', input_cache_read_tokens: '0.4', input_cache_write_tokens: '10', output_tokens: '30' },
    },
  } satisfies Record<string, Record<string, PriceVector>>;

  for (const [id, rates] of Object.entries(cases)) {
    const pricing = pricingForCopilotPublicModelId(id);
    assertEquals(priceRequest(pricing, { inputTokens: 272000 }).rates, published(rates.standardShort));
    assertEquals(priceRequest(pricing, { inputTokens: 272001 }).rates, published(rates.standardLong));
    assertEquals(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 272000 }).rates, published(rates.priorityShort));
    assertEquals(priceRequest(pricing, { serviceTier: 'priority', inputTokens: 272001 }).rates, published(rates.priorityLong));
    // Copilot has no channel that selects Ultrafast, so the tier stays on Base.
    assertEquals(priceRequest(pricing, { serviceTier: 'ultrafast', inputTokens: 0 }).rates, published(rates.standardShort));
  }
  assertEquals(pricingForCopilotPublicModelId('gpt-6.2-sol-fast'), null);
});
