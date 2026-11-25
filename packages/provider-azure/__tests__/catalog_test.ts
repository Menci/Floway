import { test } from 'vitest';

import { getAzureProvidedModels } from '../src/catalog.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const azureRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
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
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_azure',
    kind: 'azure',
    name: 'Azure Resource',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    ...rest,
    config: overrideConfig ?? config,
  };
};

test('the Azure catalog projects configured models and their upstream IDs', async () => {
  const models = await getAzureProvidedModels(azureRecord({ flagOverrides: { 'vendor-kimi': true } }));

  assertEquals(models[0]?.enabledFlags.has('vendor-kimi'), true);
  assertEquals(
    models.map(model => ({ id: model.id, displayName: model.display_name, endpoints: model.endpoints, upstreamModelId: model.upstreamModelId })),
    [
      {
        id: 'gpt-public',
        displayName: 'GPT Public',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
        upstreamModelId: 'gpt-prod',
      },
      {
        id: 'gpt-small',
        displayName: undefined,
        endpoints: { openaiChatCompletions: {} },
        upstreamModelId: 'gpt-small',
      },
    ],
  );
  assertEquals(models.map(model => model.opaqueBlobCompatibilityScope), [
    { bindToUpstream: true },
    { bindToUpstream: true },
  ]);
  assertEquals(models[0].limits.max_context_window_tokens, 128000);
});
