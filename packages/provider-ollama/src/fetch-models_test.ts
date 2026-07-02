import { test } from 'vitest';

import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { fetchOllamaCatalog } from './fetch-models.ts';
import { ProviderModelsUnavailableError, directFetcher } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const config: OllamaUpstreamConfig = assertOllamaUpstreamRecord({
  id: 'up_ollama',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
}).config;

const tagsBody = {
  models: [
    { name: 'gpt-oss:120b', modified_at: '2025-08-05T00:00:00Z' },
    { name: 'nomic-embed-text:latest', modified_at: '2025-04-01T00:00:00Z' },
    { name: 'empty', modified_at: '' },
  ],
};

const showBodies: Record<string, unknown> = {
  'gpt-oss:120b': {
    capabilities: ['completion', 'tools', 'thinking'],
    details: { family: 'gptoss', parameter_size: '116829156672', quantization_level: 'MXFP4' },
    model_info: {
      'general.architecture': 'gptoss',
      'general.parameter_count': 116829156672,
      'gptoss.context_length': 131072,
      'gptoss.embedding_length': 2880,
    },
  },
  'nomic-embed-text:latest': {
    capabilities: ['embedding'],
    details: { family: 'nomic-bert', quantization_level: 'F16' },
    model_info: {
      'general.architecture': 'nomic-bert',
      'general.parameter_count': 137000000,
      'nomic-bert.context_length': 8192,
      'nomic-bert.embedding_length': 768,
    },
  },
  // `empty` returns an error from /api/show to prove a single show failure
  // does not poison the catalog.
};

const respond = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/api/tags') return jsonResponse(tagsBody);
  if (url.pathname === '/api/show') {
    const body = await request.json() as { name?: string };
    const name = body.name ?? '';
    if (!(name in showBodies)) return new Response('not found', { status: 404 });
    return jsonResponse(showBodies[name]);
  }
  return new Response('unexpected', { status: 500 });
};

test('fetchOllamaCatalog projects /api/show capabilities + model_info into the raw model shape', async () => {
  await withMockedFetch(respond, async () => {
    const catalog = await fetchOllamaCatalog(config, directFetcher);
    const ids = catalog.data.map(m => m.id);
    // The `empty` tag's /api/show 404 drops it from the catalog without
    // affecting the others; the embedding model is included so kind/endpoints
    // projection can react to its capability set.
    assertEquals(ids.sort(), ['gpt-oss:120b', 'nomic-embed-text:latest']);

    const gptoss = catalog.data.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.capabilities.has('thinking'), true);
    assertEquals(gptoss.capabilities.has('tools'), true);
    assertEquals(gptoss.capabilities.has('embedding'), false);
    assertEquals(gptoss.contextLength, 131072);
    assertEquals(gptoss.embeddingLength, 2880);
    assertEquals(gptoss.family, 'gptoss');
    assertEquals(gptoss.architecture, 'gptoss');
    assertEquals(gptoss.quantizationLevel, 'MXFP4');
    assertEquals(gptoss.parameterCount, 116829156672);

    const embed = catalog.data.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.capabilities.has('embedding'), true);
    // model_info keys are arch-prefixed; the fetcher must enumerate keys to
    // find `.context_length` without hardcoding `gptoss.`.
    assertEquals(embed.contextLength, 8192);
    assertEquals(embed.embeddingLength, 768);
  });
});

test('fetchOllamaCatalog converts modified_at ISO string to unix seconds', async () => {
  await withMockedFetch(respond, async () => {
    const catalog = await fetchOllamaCatalog(config, directFetcher);
    const gptoss = catalog.data.find(m => m.id === 'gpt-oss:120b')!;
    // 2025-08-05T00:00:00Z → 1754352000
    assertEquals(gptoss.modifiedAt, Math.floor(Date.parse('2025-08-05T00:00:00Z') / 1000));
  });
});

test('fetchOllamaCatalog rejects with ProviderModelsUnavailableError when /api/tags returns a shape it cannot parse', async () => {
  // 200 OK + body that satisfies isRecord but lacks a `models` array. The
  // scaffold must see parseTagsResponse return null and convert that to the
  // shared error class (rather than the catalog quietly resolving to []).
  await withMockedFetch(
    async () => jsonResponse({ unexpected: 'shape' }),
    async () => {
      await assertRejects(
        () => fetchOllamaCatalog(config, directFetcher),
        ProviderModelsUnavailableError,
      );
    },
  );
});
