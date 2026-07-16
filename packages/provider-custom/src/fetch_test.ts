import { test } from 'vitest';

import { assertCustomUpstreamRecord } from './config.ts';
import {
  customFetchAlphaSearch,
  customFetchChatCompletions,
  customFetchEmbeddings,
  customFetchMessages,
  customFetchMessagesCountTokens,
  customFetchModels,
  customFetchResponses,
  customFetchResponsesCompact,
} from './fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-test',
    endpoints: { chatCompletions: {} },
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  color: null,
};

test('typed transports use default /v1/* paths', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);

  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAlphaSearch(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchEmbeddings(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/v1/chat/completions',
    'https://custom.example.com/v1/responses',
    'https://custom.example.com/v1/responses/compact',
    'https://custom.example.com/v1/messages',
    'https://custom.example.com/v1/messages/count_tokens',
    'https://custom.example.com/v1/alpha/search',
    'https://custom.example.com/v1/embeddings',
    'https://custom.example.com/v1/models',
  ]);
});

test('admin pathOverrides replace defaults and propagate to derived sub-paths', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      pathOverrides: {
        '/messages': '/api/v1/messages',
        '/responses': '/api/v1/responses',
        '/alpha/search': '/api/search',
      },
    },
  });
  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      // count_tokens / compact follow their parent override.
      await customFetchMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAlphaSearch(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      // Endpoints without an override fall back to the OpenAI default.
      await customFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/api/v1/messages',
    'https://custom.example.com/api/v1/messages/count_tokens',
    'https://custom.example.com/api/v1/responses/compact',
    'https://custom.example.com/api/search',
    'https://custom.example.com/v1/chat/completions',
  ]);
});

test('customFetchModels resolves the path from modelsFetch.endpoint', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true, endpoint: '/models' },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, 'https://custom.example.com/models');
});

test('customFetchModels falls back to the default /v1/models path when modelsFetch.endpoint is absent', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, 'https://custom.example.com/v1/models');
});

test('bearer authStyle sends the configured token via Authorization', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, 'Bearer sk-test');
  assertEquals(xApiKey, null);
});

test('authStyle "anthropic" sends x-api-key + anthropic-version', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, 'sk-test');
  assertEquals(anthropicVersion, '2023-06-01');
});

test('authStyle "anthropic" preserves a caller-supplied anthropic-version', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchMessages(
        config,
        { method: 'POST', body: '{}', headers: { 'anthropic-version': '2024-01-01' } },
        { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );

  assertEquals(anthropicVersion, '2024-01-01');
});

test('authStyle "none" sends neither Authorization nor x-api-key', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      baseUrl: 'https://internal.example.com',
      authStyle: 'none',
      endpoints: { chatCompletions: {} },
    },
  });
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, null);
  assertEquals(anthropicVersion, null);
});
