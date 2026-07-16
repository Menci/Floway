import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from './config.ts';
import { pricingForOllamaModelKey } from './pricing.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_ollama_test',
  kind: 'ollama',
  name: 'Ollama Cloud',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: {
    baseUrl: 'https://ollama.com',
    apiKey: 'ollama_test',
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  color: null,
};

test('assertOllamaUpstreamRecord parses a minimum cloud config', () => {
  const { config } = assertOllamaUpstreamRecord(baseRecord);
  assertEquals(config.baseUrl, 'https://ollama.com');
  assertEquals(config.apiKey, 'ollama_test');
  assertEquals(config.models, []);
});

test('assertOllamaUpstreamRecord accepts a self-hosted base URL without an api key', () => {
  const { config } = assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: 'http://127.0.0.1:11434' },
  });
  assertEquals(config.baseUrl, 'http://127.0.0.1:11434');
  assertEquals(config.apiKey, undefined);
});

test('assertOllamaUpstreamRecord parses manual model overrides', () => {
  const { config } = assertOllamaUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        { upstreamModelId: 'gpt-oss:120b', endpoints: { chatCompletions: {} }, display_name: 'GPT-OSS 120B' },
      ],
    },
  });
  assertEquals(config.models.length, 1);
  assertEquals(config.models[0].upstreamModelId, 'gpt-oss:120b');
  assertEquals(config.models[0].display_name, 'GPT-OSS 120B');
});

test('assertOllamaUpstreamRecord rejects a non-http(s) base URL', () => {
  assertThrows(() => assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: 'ftp://example.com' },
  }));
});

test('assertOllamaUpstreamRecord rejects a missing base URL', () => {
  assertThrows(() => assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: '' },
  }));
});

test('pricingForOllamaModelKey returns table rates for known model ids', () => {
  const gptOss = pricingForOllamaModelKey('gpt-oss:120b');
  assertEquals(gptOss?.entries[0]?.rates.input, 0.15);
  assertEquals(gptOss?.entries[0]?.rates.output, 0.6);
});

test('pricingForOllamaModelKey matches regex-keyed families', () => {
  // GLM 5 split: bare `glm-5` is cheaper than `glm-5.1` / `glm-5.2`.
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.input, 1.0);
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.output, 3.2);
  assertEquals(pricingForOllamaModelKey('glm-5.1')?.entries[0]?.rates.input, 1.4);
  assertEquals(pricingForOllamaModelKey('glm-5.2')?.entries[0]?.rates.output, 4.4);

  // MiniMax split: m2 / m2.1 / m2.5 carry cache_read 0.03; m2.7 / m3 carry
  // cache_read 0.06. Input/output are identical across both branches.
  assertEquals(pricingForOllamaModelKey('minimax-m2.1')?.entries[0]?.rates.input_cache_read, 0.03);
  assertEquals(pricingForOllamaModelKey('minimax-m2.5')?.entries[0]?.rates.input_cache_read, 0.03);
  assertEquals(pricingForOllamaModelKey('minimax-m2.7')?.entries[0]?.rates.input_cache_read, 0.06);
  const m3 = pricingForOllamaModelKey('minimax-m3');
  assertEquals(priceRequest(m3, { inputTokens: 512000 }).rates, { input: 0.3, input_cache_read: 0.06, output: 1.2 });
  assertEquals(priceRequest(m3, { inputTokens: 512001 }).rates, { input: 0.6, input_cache_read: 0.12, output: 2.4 });
});

test('pricingForOllamaModelKey returns null for ids without a defensible reference', () => {
  // Mistral Labs free tier — deliberately omitted; no commercial per-token
  // rate published.
  assertEquals(pricingForOllamaModelKey('devstral-small-2:24b'), null);
  // Version that does not map to any upstream release.
  assertEquals(pricingForOllamaModelKey('qwen3.5'), null);
  // Gemma — Vertex sells per-token only for gemma-4-26b-a4b-it (not on
  // Ollama Cloud); every Ollama Gemma tag is self-host-on-Vertex GPU-hour,
  // not per-token, so deliberately unpriced.
  assertEquals(pricingForOllamaModelKey('gemma3:27b'), null);
  assertEquals(pricingForOllamaModelKey('gemma4:31b'), null);
});
