import { test } from 'vitest';

import { assertAzureUpstreamRecord } from '../src/config.ts';
import {
  azureFetchChatCompletions,
  azureFetchAudioTranscriptions,
  azureFetchEmbeddings,
  azureFetchImagesGenerations,
  azureFetchMessages,
  azureFetchMessagesCountTokens,
  azureFetchResponses,
  azureFetchResponsesCompact,
} from '../src/fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

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

test('OpenAI v1 transports apply api-key auth and the canonical paths', async () => {
  const { config } = assertAzureUpstreamRecord(baseRecord);
  const seen: Array<{ url: string; apiKey: string | null; contentType: string | null; body: unknown }> = [];

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        contentType: request.headers.get('content-type'),
        body: request.method === 'GET' ? null : await request.json(),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchChatCompletions(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await azureFetchResponses(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await azureFetchResponsesCompact(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await azureFetchEmbeddings(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(
    seen.map(item => item.url),
    [
      'https://example.openai.azure.com/openai/v1/chat/completions',
      'https://example.openai.azure.com/openai/v1/responses',
      'https://example.openai.azure.com/openai/v1/responses/compact',
      'https://example.openai.azure.com/openai/v1/embeddings',
    ],
  );
  assertEquals(
    seen.map(item => item.apiKey),
    ['az-key', 'az-key', 'az-key', 'az-key'],
  );
  assertEquals(
    seen.map(item => item.contentType),
    ['application/json', 'application/json', 'application/json', 'application/json'],
  );
  assertEquals(seen[0].body, { model: 'set-by-provider' });
});

test('image transports append the Azure preview api-version', async () => {
  const { config } = assertAzureUpstreamRecord(baseRecord);
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchImagesGenerations(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seenUrl, 'https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
});

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
        await azureFetchAudioTranscriptions(config, 'transcribe deployment', { method: 'POST', body: new FormData() }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      },
    );
    assertEquals(seenUrl, expected);
  }
});

test('endpoint that already includes /openai/v1 routes through unchanged', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      endpoint: 'https://example.openai.azure.com/openai/v1/',
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seenUrl, 'https://example.openai.azure.com/openai/v1/responses');
});

test('Foundry project endpoints route OpenAI v1 calls under the project base', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod/',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'deepseek-prod',
          endpoints: { responses: {} },
        },
      ],
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seenUrl, 'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses');
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
          endpoints: { responses: {}, messages: {} },
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
      await azureFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/api/projects/prod/openai/v1/responses',
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});

test('native Anthropic calls land on the resource Anthropic base when a project endpoint is entered', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/api/projects/prod',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'claude-prod',
          endpoints: { messages: {} },
        },
      ],
    },
  });
  let seenUrl = '';

  await withMockedFetch(
    request => {
      seenUrl = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seenUrl, 'https://example.services.ai.azure.com/anthropic/v1/messages');
});

test('Azure Foundry Anthropic surface uses x-api-key + anthropic-version', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'claude-prod',
          endpoints: { messages: {} },
        },
      ],
    },
  });
  const seen: Array<{ url: string; apiKey: string | null; openAiKey: string | null; version: string | null; beta: string | null }> = [];

  await withMockedFetch(
    request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('x-api-key'),
        openAiKey: request.headers.get('api-key'),
        version: request.headers.get('anthropic-version'),
        beta: request.headers.get('anthropic-beta'),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { extraHeaders: new Headers({ 'anthropic-beta': 'context-1m' }), fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await azureFetchMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      apiKey: 'az-key',
      openAiKey: null,
      version: '2023-06-01',
      beta: 'context-1m',
    },
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
      apiKey: 'az-key',
      openAiKey: null,
      version: '2023-06-01',
      beta: null,
    },
  ]);
});

test('Foundry Anthropic messages target URI is accepted and splits per surface', async () => {
  const { config } = assertAzureUpstreamRecord({
    ...baseRecord,
    config: {
      endpoint: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'claude-prod',
          endpoints: { messages: {} },
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
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});
