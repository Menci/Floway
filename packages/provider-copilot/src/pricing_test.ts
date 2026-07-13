import { test } from 'vitest';

import { pricingForCopilotModelKey, pricingForCopilotPublicModelId } from './pricing.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const OPUS_BASE = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 };

test('Copilot Claude pricing uses explicit base and fast entries', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-5'), { serviceTier: 'fast', inputTokens: 0 }).rates, OPUS_BASE);
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-7'), { serviceTier: 'fast', inputTokens: 0 }).rates, { input: 30, input_cache_read: 3, input_cache_write: 37.5, output: 150 });
  assertEquals(priceRequest(pricingForCopilotPublicModelId('claude-opus-4-8'), { serviceTier: 'fast', inputTokens: 0 }).rates, { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 });
});

test('Copilot GPT-5.6 pricing resolves standard short and long entries', () => {
  const expected = {
    'gpt-5.6-sol': [
      { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 },
      { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 },
    ],
    'gpt-5.6-terra': [
      { input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 },
      { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 },
    ],
    'gpt-5.6-luna': [
      { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 },
      { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 },
    ],
  } as const;
  for (const [id, [short, long]] of Object.entries(expected)) {
    const pricing = pricingForCopilotPublicModelId(id);
    assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, short);
    assertEquals(priceRequest(pricing, { inputTokens: 272000 + 1 }).rates, long);
  }
});

test('Copilot GPT and Gemini threshold entries apply whole-request rates', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.5'), { inputTokens: 272001 }).rates, { input: 10, input_cache_read: 1, output: 45 });
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 272001 }).rates, { input: 5, input_cache_read: 0.5, output: 22.5 });
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gemini-3.1-pro-preview'), { inputTokens: 200001 }).rates, { input: 4, input_cache_read: 0.4, output: 18 });
});

test('Copilot pricing resolves exact and regex model families', () => {
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.4'), { inputTokens: 0 }).rates, { input: 2.5, input_cache_read: 0.25, output: 15 });
  assertEquals(priceRequest(pricingForCopilotPublicModelId('gpt-5.3-codex'), { inputTokens: 0 }).rates, { input: 1.75, input_cache_read: 0.175, output: 14 });
  assertEquals(priceRequest(pricingForCopilotPublicModelId('text-embedding-3-small'), { inputTokens: 0 }).rates, { input: 0.02, output: 0 });
  assertEquals(pricingForCopilotPublicModelId('totally-made-up-model'), null);
});

test('pricingForCopilotModelKey strips Claude variant suffixes before lookup', () => {
  for (const id of ['claude-opus-4-7-high', 'claude-opus-4-7-xhigh', 'claude-opus-4-7-1m', 'claude-opus-4-7-1m-internal', 'claude-opus-4-7-20251101']) {
    assertEquals(priceRequest(pricingForCopilotModelKey(id), { inputTokens: 0 }).rates, OPUS_BASE);
  }
  assertEquals(priceRequest(pricingForCopilotModelKey('claude-opus-4-7-fast'), { serviceTier: 'fast', inputTokens: 0 }).rates, { input: 30, input_cache_read: 3, input_cache_write: 37.5, output: 150 });
});
