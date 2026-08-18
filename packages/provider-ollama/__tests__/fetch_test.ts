import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from '../src/config.ts';
import {
  ollamaFetchOpenAIChatCompletions,
  ollamaFetchAudioTranscriptions,
  ollamaFetchEmbeddings,
  ollamaFetchAnthropicMessages,
  ollamaFetchOpenAIResponses,
  ollamaFetchOpenAIResponsesCompact,
  ollamaFetchShow,
  ollamaFetchTags,
} from '../src/fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_ollama_test',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
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

test('typed transports hit the fixed Ollama endpoint paths', async () => {
  const { config } = assertOllamaUpstreamRecord(baseRecord);
  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await ollamaFetchOpenAIChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchOpenAIResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchOpenAIResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchAnthropicMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchEmbeddings(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchAudioTranscriptions(config, { method: 'POST', body: new FormData() }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchTags(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await ollamaFetchShow(config, { method: 'POST', body: '{"name":"gpt-oss:120b"}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://ollama.com/v1/chat/completions',
    'https://ollama.com/v1/responses',
    'https://ollama.com/v1/responses/compact',
    'https://ollama.com/v1/messages',
    'https://ollama.com/v1/embeddings',
    'https://ollama.com/v1/audio/transcriptions',
    'https://ollama.com/api/tags',
    'https://ollama.com/api/show',
  ]);
});

test('Authorization: Bearer is set when apiKey is configured', async () => {
  const { config } = assertOllamaUpstreamRecord(baseRecord);
  let auth: string | null = null;
  await withMockedFetch(
    request => {
      auth = request.headers.get('Authorization');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await ollamaFetchOpenAIChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );
  assertEquals(auth, 'Bearer ollama_test');
});

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

test('Content-Type defaults to application/json for JSON bodies', async () => {
  const { config } = assertOllamaUpstreamRecord(baseRecord);
  let contentType: string | null = null;
  await withMockedFetch(
    request => {
      contentType = request.headers.get('Content-Type');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await ollamaFetchOpenAIChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );
  assertEquals(contentType, 'application/json');
});
