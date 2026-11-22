import { test } from 'vitest';

import { createAzureProvider } from '../src/provider.ts';
import { directFetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const azureRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_azure',
  kind: 'azure',
  name: 'Azure Resource',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-public',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
        display_name: 'GPT Public',
        limits: { max_context_window_tokens: 128000 },
      },
      {
        upstreamModelId: 'gpt-small',
        publicModelId: ' ',
        endpoints: { openaiChatCompletions: {} },
      },
    ],
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

test('createAzureProvider projects configured models and exposes pipelines', async () => {
  const provider = createAzureProvider(azureRecord({ flagOverrides: { 'vendor-kimi': true } }));
  const models = await provider.instance.getProvidedModels(directFetcher);

  assertEquals(models[0]?.enabledFlags.has('vendor-kimi'), true);
  assertEquals(models.map(model => ({
    id: model.id,
    display_name: model.display_name,
    endpoints: model.endpoints,
    providerData: model.providerData,
  })), [
    {
      id: 'gpt-public',
      display_name: 'GPT Public',
      endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
      providerData: { upstreamModelId: 'gpt-prod' },
    },
    {
      id: 'gpt-small',
      display_name: undefined,
      endpoints: { openaiChatCompletions: {} },
      providerData: { upstreamModelId: 'gpt-small' },
    },
  ]);
  assertEquals(models.map(model => model.opaqueBlobCompatibilityScope), [
    { bindToUpstream: true },
    { bindToUpstream: true },
  ]);
  assertEquals(provider.pipelines.openaiResponses !== undefined, true);
  assertEquals(provider.pipelines.decision !== undefined, true);
});
