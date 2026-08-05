import { test } from 'vitest';

import { assertAzureUpstreamRecord } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_azure',
  kind: 'azure',
  name: 'Azure Resource',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com/',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
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
  const parsed = assertAzureUpstreamRecord(baseRecord);
  assertEquals(parsed.config.endpoint, 'https://example.openai.azure.com');
  assertEquals(parsed.config.models.length, 1);

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
          endpoint: 'http://example.openai.azure.com/openai/v1',
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
          endpoint: 'https://custom.example.com/openai/v1',
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

  for (const config of [
    { ...(baseRecord.config as Record<string, unknown>), models: [] },
    { ...(baseRecord.config as Record<string, unknown>), apiKey: '' },
  ]) {
    assertThrows(() => assertAzureUpstreamRecord({ ...baseRecord, config }));
  }
});

test('assertAzureUpstreamRecord rejects rerank models', () => {
  for (const kind of ['rerank', 'chat']) {
    assertThrows(
      () => assertAzureUpstreamRecord({
        ...baseRecord,
        config: {
          ...(baseRecord.config as Record<string, unknown>),
          models: [{
            upstreamModelId: 'reranker',
            kind,
            endpoints: { rerank: {} },
            rerankTarget: { protocol: 'cohere-v2' },
          }],
        },
      }),
      Error,
      'rerank models require a custom upstream',
    );
  }
});
