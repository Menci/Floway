import { test } from 'vitest';

import { assertAzureUpstreamRecord } from '../src/config.ts';
import {
  azureFetchOpenAIAudioTranscriptions,
  azureFetchAnthropicMessages,
  azureFetchOpenAIResponses,
} from '../src/fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

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

test('audio transcription selects the deployment on every admitted endpoint shape', async () => {
  const endpoints = [
    ['https://example.openai.azure.com/', 'https://example.openai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
    ['https://example.openai.azure.com/openai/v1/', 'https://example.openai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
    ['https://example.services.ai.azure.com/', 'https://example.services.ai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
    ['https://example.services.ai.azure.com/api/projects/prod/', 'https://example.services.ai.azure.com/openai/deployments/transcribe%20deployment/audio/transcriptions?api-version=2025-04-01-preview'],
  ] as const;

  for (const [endpoint, expected] of endpoints) {
    const { config } = assertAzureUpstreamRecord({
      ...baseRecord,
      config: { ...(baseRecord.config as Record<string, unknown>), endpoint },
    });
    let seenUrl = '';
    await withMockedFetch(
      request => {
        seenUrl = request.url;
        return new Response('{}', { status: 200 });
      },
      async () => {
        await azureFetchOpenAIAudioTranscriptions(config, 'transcribe deployment', { method: 'POST', body: new FormData() }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      },
    );
    assertEquals(seenUrl, expected);
  }
});

test('Foundry project endpoints split OpenAI v1 vs Anthropic surfaces', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/openai/v1',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'deepseek-prod',
          endpoints: { openaiResponses: {}, anthropicMessages: {} },
        },
      ],
    },
  });
  const seen: string[] = [];

  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchOpenAIResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await azureFetchAnthropicMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});
