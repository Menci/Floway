import { test } from 'vitest';

import { callCustom, customInput } from './pipeline-fixture.ts';
import { assertCustomUpstreamRecord } from '../src/config.ts';
import { customFetchModels } from '../src/fetch.ts';
import { createCustomProvider } from '../src/provider.ts';
import { directFetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const baseConfig = {
  baseUrl: 'https://custom.example.com',
  apiKey: 'sk-test',
  endpoints: { openaiChatCompletions: {} },
  ingressHeadersRules: [],
};

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: baseConfig,
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

const model = stubProviderModel();
const messages = { ...customInput(model, { max_tokens: 10, messages: [] }), 'request.anthropicBeta': [] };

test('admin pathOverrides replace defaults and propagate to derived sub-paths', async () => {
  const { pipelines } = createCustomProvider({
    ...baseRecord,
    config: {
      ...baseConfig,
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
      const { pathname } = new URL(request.url);
      return pathname.endsWith('/messages') || pathname.endsWith('/chat/completions') ? sseResponse() : jsonResponse({});
    },
    async () => {
      await callCustom(pipelines.anthropicMessages, messages);
      await callCustom(pipelines.anthropicMessagesCountTokens, messages);
      await callCustom(pipelines.openaiResponses, { ...customInput(model, { input: [] }), 'request.action': 'compact' });
      await callCustom(pipelines.alphaSearch, customInput(model, { query: 'hi' }));
      await callCustom(pipelines.openaiChatCompletions, customInput(model, { messages: [] }));
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

test('the catalog uses modelsFetch.authStyle independently from the inference protocol', async () => {
  const record = {
    ...baseRecord,
    config: {
      ...baseConfig,
      endpoints: { anthropicMessages: {} },
      modelsFetch: { enabled: true, authStyle: 'bearer' },
    },
  };
  const { config } = assertCustomUpstreamRecord(record);
  const { pipelines } = createCustomProvider(record);
  const observed: { hostname: string; authorization: string | null; xApiKey: string | null }[] = [];
  await withMockedFetch(
    request => {
      observed.push({
        hostname: new URL(request.url).hostname,
        authorization: request.headers.get('authorization'),
        xApiKey: request.headers.get('x-api-key'),
      });
      return request.method === 'GET' ? jsonResponse({}) : sseResponse();
    },
    async () => {
      await customFetchModels(config, directFetcher);
      await callCustom(pipelines.anthropicMessages, messages);
    },
  );

  assertEquals(observed, [
    { hostname: 'custom.example.com', authorization: 'Bearer sk-test', xApiKey: null },
    { hostname: 'custom.example.com', authorization: null, xApiKey: 'sk-test' },
  ]);
});

test('an empty apiKey omits Authorization, x-api-key, and anthropic-version', async () => {
  const { pipelines } = createCustomProvider({
    ...baseRecord,
    config: { ...baseConfig, baseUrl: 'https://internal.example.com', apiKey: '' },
  });
  const authorization: (string | null)[] = [];
  const xApiKey: (string | null)[] = [];
  const anthropicVersion: (string | null)[] = [];
  await withMockedFetch(
    request => {
      authorization.push(request.headers.get('authorization'));
      xApiKey.push(request.headers.get('x-api-key'));
      anthropicVersion.push(request.headers.get('anthropic-version'));
      return sseResponse();
    },
    async () => {
      await callCustom(pipelines.openaiChatCompletions, customInput(model, { messages: [] }));
      await callCustom(pipelines.anthropicMessages, messages);
    },
  );

  assertEquals(authorization, [null, null]);
  assertEquals(xApiKey, [null, null]);
  assertEquals(anthropicVersion, [null, null]);
});
