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

test('pricingForOllamaModelKey matches regex-keyed families', () => {
  // GLM 5 split: bare `glm-5` is cheaper than `glm-5.1` / `glm-5.2`.
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.input_tokens, '0.000001');
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.output_tokens, '0.0000032');
  assertEquals(pricingForOllamaModelKey('glm-5.1')?.entries[0]?.rates.input_tokens, '0.0000014');
  assertEquals(pricingForOllamaModelKey('glm-5.2')?.entries[0]?.rates.output_tokens, '0.0000044');

  // MiniMax split: m2 / m2.1 / m2.5 carry cache_read 0.03; m2.7 / m3 carry
  // cache_read 0.06. Input/output are identical across both branches.
  assertEquals(pricingForOllamaModelKey('minimax-m2.1')?.entries[0]?.rates.input_cache_read_tokens, '0.00000003');
  assertEquals(pricingForOllamaModelKey('minimax-m2.5')?.entries[0]?.rates.input_cache_read_tokens, '0.00000003');
  assertEquals(pricingForOllamaModelKey('minimax-m2.7')?.entries[0]?.rates.input_cache_read_tokens, '0.00000006');
  const m3 = pricingForOllamaModelKey('minimax-m3');
  assertEquals(priceRequest(m3, { inputTokens: 512000 }).rates, { input_tokens: '0.0000003', input_cache_read_tokens: '0.00000006', output_tokens: '0.0000012' });
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

test('Ollama prices Gemma 4 31B from the commodity floor', () => {
  // This reverses an earlier omission that reasoned only about Google's own
  // surface. Gemma 4 is open-weights-only, which is the case the table
  // already answers with the cheapest credible commodity host — the same
  // branch that prices gpt-oss from Groq and Nemotron from DeepInfra — and
  // `gemma4:31b` is a live Ollama Cloud SKU rather than a self-host-only tag.
  const rates = published({ input_tokens: '0.13', output_tokens: '0.38' });
  assertEquals(priceRequest(pricingForOllamaModelKey('gemma4:31b'), { inputTokens: 0 }).rates, rates);
  assertEquals(priceRequest(pricingForOllamaModelKey('gemma4'), { inputTokens: 0 }).rates, rates);
  // Ollama Cloud serves no other Gemma 4 size, and the cheaper 26B and E4B
  // builds must not inherit 31B's rate on a self-hosted deployment.
  assertEquals(pricingForOllamaModelKey('gemma4:26b'), null);
});

test('Ollama prices a dated DeepSeek V4-Flash tag as the undated one', () => {
  const rates = published({ input_tokens: '0.14', input_cache_read_tokens: '0.0028', output_tokens: '0.28' });
  assertEquals(priceRequest(pricingForOllamaModelKey('deepseek-v4-flash'), { inputTokens: 0 }).rates, rates);
  assertEquals(priceRequest(pricingForOllamaModelKey('deepseek-v4-flash:0731'), { inputTokens: 0 }).rates, rates);
});

test('Ollama prices Kimi K3 from Moonshot international', () => {
  assertEquals(
    priceRequest(pricingForOllamaModelKey('kimi-k3'), { inputTokens: 0 }).rates,
    published({ input_tokens: '3.0', input_cache_read_tokens: '0.3', output_tokens: '15.0' }),
  );
});
