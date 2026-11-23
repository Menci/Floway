import { test } from 'vitest';

import { callOllama, ollamaInput } from './pipeline-fixture.ts';
import { ollamaPipelines } from '../src/index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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
  modelsCache: null,
  hue: 210,
};

test('Authorization header is omitted entirely when apiKey is absent (local daemon)', async () => {
  const record = {
    ...baseRecord,
    config: { baseUrl: 'http://127.0.0.1:11434' },
  };
  let auth: string | null = 'present';
  await withMockedFetch(
    request => {
      auth = request.headers.get('Authorization');
      return sseResponse();
    },
    async () => {
      await callOllama(ollamaPipelines.openaiChatCompletions, ollamaInput(record, stubProviderModel(), { messages: [] }, [['authorization', 'Bearer client-key']]));
    },
  );
  assertEquals(auth, null);
});
