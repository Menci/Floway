import { test } from 'vitest';

import { azureInput, callAzure } from './pipeline-fixture.ts';
import { azurePipelines, toAzureUpstreamFacts } from '../src/index.ts';
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
    const upstream = toAzureUpstreamFacts({
      ...baseRecord,
      config: { ...(baseRecord.config as Record<string, unknown>), endpoint },
    });
    let seenUrl = '';
    await withMockedFetch(
      async request => {
        seenUrl = request.url;
        assertEquals(request.headers.get('api-key'), 'az-key');
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
        const result = await callAzure(azurePipelines.openaiAudioTranscriptions, azureInput(upstream, stubProviderModel({ upstreamModelId: 'transcribe deployment' }), {
          entries: [
            { kind: 'text', name: 'model', value: 'public-transcription' },
            { kind: 'file', name: 'file', bytes: Bytes.fromUtf8('audio bytes'), filename: 'audio.ogg', contentType: 'audio/ogg' },
          ],
        }));
        assertEquals(result['response.openaiAudioTranscriptions'], { kind: 'ok' });
      },
    );
    assertEquals(seenUrl, expected);
  }
});

test('Foundry project endpoints split OpenAI v1 vs Anthropic surfaces', async () => {
  const record: UpstreamRecord = {
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
  };
  const provider = createAzureProvider(record);
  const upstream = toAzureUpstreamFacts(record);
  const seen: string[] = [];

  await withMockedFetch(
    request => {
      seen.push(request.url);
      assertEquals(request.headers.get('anthropic-beta'), null);
      return sseResponse();
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(() => Promise.reject(new Error('Unexpected catalog fetch')));
      assertExists(model);
      await callAzure(azurePipelines.openaiResponses, { ...azureInput(upstream, model, { input: [] }), 'request.action': 'generate' });
      await callAzure(azurePipelines.anthropicMessages, { ...azureInput(upstream, model, { max_tokens: 16, messages: [] }), 'request.anthropicBeta': [] });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});

test('Azure preserves completions and image generation response bodies', async () => {
  const upstream = toAzureUpstreamFacts(baseRecord);
  const model = stubProviderModel({ upstreamModelId: 'deployment' });
  await withMockedFetch(
    async request => {
      assertEquals(await request.json(), { prompt: 'hello', model: 'deployment' });
      if (request.url === 'https://example.openai.azure.com/openai/v1/completions') return new Response('completion body');
      assertEquals(request.url, 'https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
      return jsonResponse({ data: [{ b64_json: 'eA==' }] });
    },
    async () => {
      const input = azureInput(upstream, model, { prompt: 'hello' });
      const completion = await callAzure(azurePipelines.openaiCompletions, input);
      assertEquals(completion['response.openaiCompletions'], { kind: 'ok' });
      assertEquals(completion.body.utf8(), 'completion body');
      const image = await callAzure(azurePipelines.openaiImagesGenerations, input);
      assertEquals(image['response.openaiImagesGenerations'], { kind: 'ok' });
      assertEquals(image.body.utf8(), '{"data":[{"b64_json":"eA=="}]}');
    },
  );
});

test('Azure Decision calls the resource-scoped target and returns its dialect', async () => {
  const record: UpstreamRecord = {
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/openai/v1',
      apiKey: 'az-key',
      models: [{ upstreamModelId: 'decision-prod', endpoints: { decision: {} } }],
    },
  };
  const upstream = toAzureUpstreamFacts(record);
  const [model] = await createAzureProvider(record).instance.getProvidedModels(() => Promise.reject(new Error('Unexpected catalog fetch')));
  const payload = {
    sourceProtocol: 'typesafe-systemone' as const,
    raw: { model: 'decision-public', state: 'evidence', questions: { positive: { type: 'noul' } } },
    state: { kind: 'text' as const, value: 'evidence' },
    questions: [{ type: 'noul' as const, name: 'positive' }],
  };
  await withMockedFetch(
    async request => {
      assertEquals(request.url, 'https://example.services.ai.azure.com/v1/systemone');
      assertEquals(request.headers.get('api-key'), 'az-key');
      assertEquals(await request.json(), { ...payload.raw, model: 'decision-prod' });
      return jsonResponse({ answers: {} });
    },
    async () => {
      const result = await callAzure(azurePipelines.decision, azureInput(upstream, model, payload));
      assertEquals(result['response.decision'], { kind: 'ok', target: { protocol: 'typesafe-systemone' } });
      assertEquals(result['response.modelKey'], 'decision-prod');
    },
  );
});
