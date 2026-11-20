import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/config.ts';
import {
  customFetchAlphaSearch,
  customFetchOpenAIChatCompletions,
  customFetchAnthropicMessages,
  customFetchAnthropicMessagesCountTokens,
  customFetchModels,
  customFetchOpenAIResponsesCompact,
} from '../src/fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { callProviderPipeline, assertEquals, assertExists, jsonResponse, noopUpstreamCallOptions, withMockedFetch } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    apiKey: 'sk-test',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

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
      await customFetchAnthropicMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      // count_tokens / compact follow their parent override.
      await customFetchAnthropicMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchOpenAIResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAlphaSearch(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      // Endpoints without an override fall back to the OpenAI default.
      await customFetchOpenAIChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
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

test('customFetchModels uses modelsFetch.authStyle independently from the inference protocol', async () => {
  const { config: stored } = assertCustomUpstreamRecord(baseRecord);
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...stored,
      endpoints: { anthropicMessages: {} },
      modelsFetch: { enabled: true, authStyle: 'bearer' },
    },
  });
  const observed: { hostname: string; authorization: string | null; xApiKey: string | null }[] = [];
  await withMockedFetch(
    request => {
      observed.push({
        hostname: new URL(request.url).hostname,
        authorization: request.headers.get('authorization'),
        xApiKey: request.headers.get('x-api-key'),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAnthropicMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(observed, [
    { hostname: 'custom.example.com', authorization: 'Bearer sk-test', xApiKey: null },
    { hostname: 'custom.example.com', authorization: null, xApiKey: 'sk-test' },
  ]);
});

test('an empty apiKey sends neither Authorization nor x-api-key', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      baseUrl: 'https://internal.example.com',
      apiKey: '',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
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
      await customFetchOpenAIChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAnthropicMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, null);
  assertEquals(anthropicVersion, null);
});
