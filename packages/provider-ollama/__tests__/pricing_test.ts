import { test } from 'vitest';

import { pricingForOllamaModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('pricingForOllamaModelKey returns table rates for known model ids', () => {
  const gptOss = pricingForOllamaModelKey('gpt-oss:120b');
  assertEquals(gptOss?.entries[0]?.rates.input_tokens, '0.00000015');
  assertEquals(gptOss?.entries[0]?.rates.output_tokens, '0.0000006');
});

test('current and retired Ollama models retain distinct valuation sources', () => {
  // GLM 5 split: bare `glm-5` is cheaper than `glm-5.1` / `glm-5.2`.
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.input_tokens, '0.000001');
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.output_tokens, '0.0000032');
  assertEquals(pricingForOllamaModelKey('glm-5.1')?.entries[0]?.rates.input_tokens, '0.0000014');
  assertEquals(pricingForOllamaModelKey('glm-5.2')?.entries[0]?.rates.output_tokens, '0.0000044');

  // Retired releases keep their notional rates; current models use Ollama rates.
  assertEquals(pricingForOllamaModelKey('minimax-m2.1')?.entries[0]?.rates.input_cache_read_tokens, '0.00000003');
  assertEquals(pricingForOllamaModelKey('minimax-m2.5')?.entries[0]?.rates.input_cache_read_tokens, '0.00000003');
  assertEquals(pricingForOllamaModelKey('minimax-m2.7')?.entries[0]?.rates.input_cache_read_tokens, '0.00000006');
  const m3 = pricingForOllamaModelKey('minimax-m3');
  assertEquals(priceRequest(m3, { inputTokens: 512000 }).rates, { input_tokens: '0.0000006', input_cache_read_tokens: '0.00000012', output_tokens: '0.0000024' });
  assertEquals(priceRequest(m3, { inputTokens: 512001 }).rates, { input_tokens: '0.0000006', input_cache_read_tokens: '0.00000012', output_tokens: '0.0000024' });
});

test('pricingForOllamaModelKey returns null for ids without a defensible reference', () => {
  // Mistral Labs free tier — deliberately omitted; no commercial per-token
  // rate published.
  assertEquals(pricingForOllamaModelKey('devstral-small-2:24b'), null);
  // Version that does not map to any upstream release.
  assertEquals(pricingForOllamaModelKey('qwen3.5'), null);
  // Gemma 3 stays unpriced: Google sells it by Vertex GPU-hour rather than
  // per token, and it is not an Ollama Cloud SKU, so no host meters it the
  // way this table records.
  assertEquals(pricingForOllamaModelKey('gemma3:27b'), null);
});

test('Ollama official Gemma rates apply to its published 31B cloud aliases', () => {
  const rates = published({ input_tokens: '0.14', input_cache_read_tokens: '0.05', output_tokens: '0.40' });
  for (const key of ['gemma4:31b', 'gemma4', 'gemma4:31b-cloud', 'gemma4:cloud']) assertEquals(priceRequest(pricingForOllamaModelKey(key), { inputTokens: 0 }).rates, rates);
  assertEquals(pricingForOllamaModelKey('gemma4:26b'), null);
});

test('Ollama prices a dated DeepSeek V4-Flash tag as the undated one', () => {
  const rates = published({ input_tokens: '0.14', input_cache_read_tokens: '0.0028', output_tokens: '0.28' });
  assertEquals(priceRequest(pricingForOllamaModelKey('deepseek-v4-flash'), { inputTokens: 0 }).rates, rates);
  assertEquals(priceRequest(pricingForOllamaModelKey('deepseek-v4-flash:0731'), { inputTokens: 0 }).rates, rates);
});

test('Ollama prices Kimi K3 at its official standard rate', () => {
  assertEquals(
    priceRequest(pricingForOllamaModelKey('kimi-k3'), { inputTokens: 0 }).rates,
    published({ input_tokens: '3.0', input_cache_read_tokens: '0.3', output_tokens: '15.0' }),
  );
});

test('DeepSeek standard rates are estimated independently of the response service tier', () => {
  const rates = published({ input_tokens: '1.32', input_cache_read_tokens: '0.044', output_tokens: '3.96' });
  for (const key of ['deepseek-v4-pro', 'deepseek-v4-pro:0813', 'deepseek-v4-pro:0813-cloud']) assertEquals(priceRequest(pricingForOllamaModelKey(key), { serviceTier: 'default', inputTokens: 1 }).rates, rates);
  assertEquals(pricingForOllamaModelKey('deepseek-v4-pro:unknown'), null);
});

test('all currently published cloud model IDs have standard valuation rates', () => {
  for (const key of ['deepseek-v4.1-flash', 'deepseek-v4-pro:0813', 'gemma4:31b', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'minimax-m3', 'minimax-m2.7', 'mistral-large-4', 'mistral-large-3:675b', 'nemotron-3-nano:30b', 'nemotron-3-super', 'nemotron-3-ultra']) {
    if (pricingForOllamaModelKey(key) === null) throw new Error(`Missing standard valuation: ${key}`);
  }
  assertEquals(pricingForOllamaModelKey('gpt-oss:120b')?.entries[0]?.rates.input_cache_read_tokens, '0.000000014');
  assertEquals(pricingForOllamaModelKey('mistral-large-3:675b')?.entries[0]?.rates.input_cache_read_tokens, undefined);
});
