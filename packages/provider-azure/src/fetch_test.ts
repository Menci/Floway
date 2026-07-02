import { test } from 'vitest';

import { assertAzureUpstreamRecord } from './config.ts';
import {
  azureFetchChatCompletions,
  azureFetchEmbeddings,
  azureFetchImagesGenerations,
  azureFetchMessages,
  azureFetchMessagesCountTokens,
  azureFetchResponses,
  azureFetchResponsesCompact,
} from './fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
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
      await azureFetchChatCompletions(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher });
      await azureFetchResponses(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher });
      await azureFetchResponsesCompact(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher });
      await azureFetchEmbeddings(config, { method: 'POST', body: JSON.stringify({ model: 'set-by-provider' }) }, { fetcher: directFetcher });
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
      await azureFetchImagesGenerations(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
    },
  );

  assertEquals(seenUrl, 'https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
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
      await azureFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await azureFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await azureFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { extraHeaders: new Headers({ 'anthropic-beta': 'context-1m' }), fetcher: directFetcher });
      await azureFetchMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await azureFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
    },
  );

  assertEquals(seen, [
    'https://example.services.ai.azure.com/anthropic/v1/messages',
  ]);
});
