import { test } from 'vitest';

import { callCustom, customInput } from './pipeline-fixture.ts';
import { assertCustomUpstreamRecord } from '../src/config.ts';
import { customFetchModels } from '../src/fetch.ts';
import { customPipelines } from '../src/pipelines.ts';
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
const messages = (record: UpstreamRecord) => ({ ...customInput(record, model, { max_tokens: 10, messages: [] }), 'request.anthropicBeta': [] });

test('admin pathOverrides replace defaults and propagate to derived sub-paths', async () => {
  const record = {
    ...baseRecord,
    config: {
      ...baseConfig,
      pathOverrides: {
        '/messages': '/api/v1/messages',
        '/responses': '/api/v1/responses',
        '/alpha/search': '/api/search',
      },
    },
  };
  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      const { pathname } = new URL(request.url);
      return pathname.endsWith('/messages') || pathname.endsWith('/chat/completions') ? sseResponse() : jsonResponse({});
    },
    async () => {
      await callCustom(customPipelines.anthropicMessages, messages(record));
      await callCustom(customPipelines.anthropicMessagesCountTokens, messages(record));
      await callCustom(customPipelines.openaiResponses, { ...customInput(record, model, { input: [] }), 'request.action': 'compact' });
      await callCustom(customPipelines.alphaSearch, customInput(record, model, { query: 'hi' }));
      await callCustom(customPipelines.openaiChatCompletions, customInput(record, model, { messages: [] }));
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
      await callCustom(customPipelines.anthropicMessages, messages(record));
    },
  );

  assertEquals(observed, [
    { hostname: 'custom.example.com', authorization: 'Bearer sk-test', xApiKey: null },
    { hostname: 'custom.example.com', authorization: null, xApiKey: 'sk-test' },
  ]);
});

test('an empty apiKey omits Authorization, x-api-key, and anthropic-version', async () => {
  const record = {
    ...baseRecord,
    config: { ...baseConfig, baseUrl: 'https://internal.example.com', apiKey: '' },
  };
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
      await callCustom(customPipelines.openaiChatCompletions, customInput(record, model, { messages: [] }));
      await callCustom(customPipelines.anthropicMessages, messages(record));
    },
  );

  assertEquals(authorization, [null, null]);
  assertEquals(xApiKey, [null, null]);
  assertEquals(anthropicVersion, [null, null]);
});

test('configured Anthropic versions replace the default and beta comes from the protocol fact', async () => {
  const record = {
    ...baseRecord,
    config: {
      ...baseConfig,
      ingressHeadersRules: [
        { key: 'anthropic-version', value: 'test-version' },
        { key: 'anthropic-version', value: 'extended-version' },
      ],
    },
  };
  const input = customInput(record, model, { max_tokens: 10, messages: [] }, [
    ['Anthropic-Version', 'client-version'],
    ['Anthropic-Beta', 'client-beta'],
    ['X-Api-Key', 'client-api-key'],
  ]);
  const responses: string[][] = [];

  await callCustom(customPipelines.anthropicMessages, { ...input, 'request.anthropicBeta': ['first', 'second'] }, async (url, init) => {
    const request = new Request(url, { method: init.method, headers: init.headers });
    responses.push([...request.headers.values()]);
    return sseResponse();
  });

  assertEquals(responses, [['first,second', 'test-version, extended-version', 'application/json', 'sk-test']]);
});
