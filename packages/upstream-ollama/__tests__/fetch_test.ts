import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { ollamaFetchOpenAIChatCompletions } from '../src/fetch.ts';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';
import type { UpstreamRecord } from '@floway-dev/upstream';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/upstream';

const baseRecord: UpstreamRecord = {
  id: 'up_ollama_test',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: {
    baseUrl: 'https://ollama.com',
    apiKey: 'ollama_test',
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
};

test('Authorization header is omitted entirely when apiKey is absent (local daemon)', async () => {
  const { config } = assertOllamaUpstreamRecord({
    ...baseRecord,
    config: { baseUrl: 'http://127.0.0.1:11434' },
  });
  let auth: string | null = 'present';
  await withMockedFetch(
    request => {
      auth = request.headers.get('Authorization');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await ollamaFetchOpenAIChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );
  assertEquals(auth, null);
});
