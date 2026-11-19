import { test } from 'vitest';

import { assertAzureUpstreamRecord } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_azure',
  kind: 'azure',
  name: 'Azure Resource',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com/',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
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
};

test('assertAzureUpstreamRecord validates Azure opaque config strictly', () => {
  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        kind: 'custom',
      }),
    Error,
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com?tenant=a',
        },
      }),
    Error,
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.inference.ai.azure.com/openai/v1',
        },
      }),
    Error,
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com/openai',
        },
      }),
    Error,
  );

});

test('assertAzureUpstreamRecord rejects rerank models', () => {
  assertThrows(
    () => assertAzureUpstreamRecord({
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
  );
});
