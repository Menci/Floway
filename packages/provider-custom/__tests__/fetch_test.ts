import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/config.ts';
import { customFetchModels } from '../src/fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

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

test('customFetchModels uses its configured auth style without inference credentials', async () => {
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
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall }, 'next-page');
    },
  );

  assertEquals(observed, [
    { hostname: 'custom.example.com', authorization: 'Bearer sk-test', xApiKey: null },
    { hostname: 'custom.example.com', authorization: 'Bearer sk-test', xApiKey: null },
  ]);
});
