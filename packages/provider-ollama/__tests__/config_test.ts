import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from '../src/config.ts';
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
  modelsCache: null,
  hue: 210,
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

test('assertOllamaUpstreamRecord rejects rerank models', () => {
  assertThrows(
    () => assertOllamaUpstreamRecord({
      ...baseRecord,
      config: {
        ...(baseRecord.config as Record<string, unknown>),
        models: [{
          upstreamModelId: 'reranker',
          kind: 'rerank',
          endpoints: { rerank: {} },
          rerankTarget: { protocol: 'cohere-v2' },
        }],
      },
    }),
    Error,
    'rerank models require a custom upstream',
  );
});
