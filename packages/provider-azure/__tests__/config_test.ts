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
    'Expected azure upstream record, got custom',
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
    'endpoint: must be an http(s) URL without query or fragment',
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
    'endpoint: must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com',
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
    'endpoint: must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.services.ai.azure.com/api/projects/prod/anthropic/v1/messages',
        },
      }),
    Error,
    'endpoint: must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL',
  );

  assertThrows(
    () =>
      assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          endpoint: 'https://example.openai.azure.com/?',
        },
      }),
    Error,
    'endpoint: must be an http(s) URL without query or fragment',
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
    'rerank models require a custom upstream',
  );
});

test('assertAzureUpstreamRecord rejects an operator-authored decision target', () => {
  assertThrows(
    () => assertAzureUpstreamRecord({
      ...baseRecord,
      config: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: 'key',
        models: [{
          upstreamModelId: 'decision-1',
          kind: 'decision',
          endpoints: { decision: {} },
          decisionTarget: { protocol: 'typesafe-systemone' },
        }],
      },
    }),
    Error,
    'decision target is not configurable on this upstream',
  );
});
