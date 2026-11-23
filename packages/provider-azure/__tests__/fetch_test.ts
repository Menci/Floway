import { test } from 'vitest';

import { azureInput, callAzure } from './pipeline-fixture.ts';
import { createAzureProvider } from '../src/provider.ts';
import { Bytes } from '@floway-dev/pipeline';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertExists, assertFalse, jsonResponse, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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
    const { pipelines } = createAzureProvider({
      ...baseRecord,
      config: { ...(baseRecord.config as Record<string, unknown>), endpoint },
    });
    let seenUrl = '';
    await withMockedFetch(
      async request => {
        seenUrl = request.url;
        const body = await request.formData();
        assertFalse(body.has('model'));
        const file = body.get('file');
        if (!(file instanceof File)) throw new Error('Expected multipart audio file');
        assertEquals(file.name, 'audio.ogg');
        assertEquals(file.type, 'audio/ogg');
        assertEquals(await file.text(), 'audio bytes');
        return jsonResponse({});
      },
      async () => {
        await callAzure(pipelines.openaiAudioTranscriptions, azureInput(stubProviderModel({ upstreamModelId: 'transcribe deployment' }), {
          entries: [
            { kind: 'text', name: 'model', value: 'public-transcription' },
            { kind: 'file', name: 'file', bytes: Bytes.fromUtf8('audio bytes'), filename: 'audio.ogg', contentType: 'audio/ogg' },
          ],
        }));
      },
    );
    assertEquals(seenUrl, expected);
  }
});

test('Foundry project endpoints split OpenAI v1 vs Anthropic surfaces', async () => {
  const provider = createAzureProvider({
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
      return sseResponse();
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(() => Promise.reject(new Error('Unexpected catalog fetch')));
      assertExists(model);
      await callAzure(provider.pipelines.openaiResponses, { ...azureInput(model, { input: [] }), 'request.action': 'generate' });
      await callAzure(provider.pipelines.anthropicMessages, { ...azureInput(model, { max_tokens: 16, messages: [] }), 'request.anthropicBeta': [] });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});
