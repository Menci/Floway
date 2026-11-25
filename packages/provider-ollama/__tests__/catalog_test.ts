import { test } from 'vitest';

import { fetchOllamaProvidedModels } from '../src/catalog.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const buildRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_ollama',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

const tagsAndShow = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/api/tags') {
    return jsonResponse({
      models: [
        { name: 'gpt-oss:120b', modified_at: '2025-08-05T00:00:00Z' },
        { name: 'nomic-embed-text:latest', modified_at: '2025-04-01T00:00:00Z' },
      ],
    });
  }
  if (url.pathname === '/api/show') {
    const body = await request.json() as { name?: string };
    if (body.name === 'gpt-oss:120b') {
      return jsonResponse({
        capabilities: ['completion', 'tools', 'thinking'],
        details: { family: 'gptoss' },
        model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 },
      });
    }
    if (body.name === 'nomic-embed-text:latest') {
      return jsonResponse({
        capabilities: ['embedding'],
        details: { family: 'nomic-bert' },
        model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 8192 },
      });
    }
    return new Response('not found', { status: 404 });
  }
  return new Response('unexpected', { status: 500 });
};

test('getProvidedModels projects chat and embedding models from their capabilities', async () => {
  const upstream = buildRecord();
  await withMockedFetch(tagsAndShow, async () => {
    const models = await fetchOllamaProvidedModels(upstream, testFetcher);
    const gptoss = models.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.kind, 'chat');
    assertEquals(Object.keys(gptoss.endpoints).sort(), ['anthropicMessages', 'openaiChatCompletions', 'openaiCompletions', 'openaiResponses']);
    assertEquals(gptoss.limits.max_context_window_tokens, 131072);
    assertEquals(gptoss.opaqueBlobCompatibilityScope, { bindToUpstream: true });
    // OLLAMA_MODEL_PRICING covers gpt-oss:120b, so pricing flows through into
    // the ProviderModel on the auto path.
    assertEquals(gptoss.pricing?.entries[0]?.rates.input_tokens, '0.00000015');
    assertEquals(gptoss.pricing?.entries[0]?.rates.output_tokens, '0.0000006');
    const embed = models.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.kind, 'embedding');
    assertEquals(Object.keys(embed.endpoints), ['openaiEmbeddings']);
  });
});

test('getProvidedModels merges manual overrides in front of auto-fetched models and drops the auto duplicate', async () => {
  const upstream = buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      apiKey: 'ollama_test',
      models: [{
        upstreamModelId: 'gpt-oss:120b',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Pinned 120B',
        chat: { image_detail_original: true },
        pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] },
      }],
    },
  });
  await withMockedFetch(tagsAndShow, async () => {
    const models = await fetchOllamaProvidedModels(upstream, testFetcher);
    // Manual entry appears first; the auto duplicate is filtered out so the
    // public id resolves to the manual entry's narrower endpoints map.
    assertEquals(models[0].id, 'gpt-oss:120b');
    assertEquals(models[0].display_name, 'Pinned 120B');
    assertEquals(Object.keys(models[0].endpoints), ['openaiChatCompletions']);
    assertEquals(models[0].chat, { image_detail_original: true });
    assertEquals(models[0].opaqueBlobCompatibilityScope, { bindToUpstream: true });
    assertEquals(models[0].pricing, { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] });
    // No duplicate gpt-oss:120b further down.
    assertEquals(models.filter(m => m.id === 'gpt-oss:120b').length, 1);
  });
});

test('manual transcription endpoints are classified from configured capabilities', async () => {
  const upstream = buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      models: [{ upstreamModelId: 'qwen-audio:latest', kind: 'chat', endpoints: { openaiAudioTranscriptions: {} }, chat: { image_detail_original: true } }],
    },
  });
  await withMockedFetch(() => jsonResponse({ models: [] }), async () => {
    const models = await fetchOllamaProvidedModels(upstream, testFetcher);
    assertEquals(models.map(model => model.kind), ['transcription']);
    assertEquals(models[0]?.chat, undefined);
  });
});
