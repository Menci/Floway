import { test } from 'vitest';

import { assertOllamaUpstreamRecord } from './config.ts';
import {
  ollamaFetchChatCompletions,
  ollamaFetchEmbeddings,
  ollamaFetchMessages,
  ollamaFetchResponses,
  ollamaFetchResponsesCompact,
  ollamaFetchShow,
  ollamaFetchTags,
} from './fetch.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
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
      await ollamaFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
      await ollamaFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
      await ollamaFetchResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
      await ollamaFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
      await ollamaFetchEmbeddings(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
      await ollamaFetchTags(config, { method: 'GET' }, { fetcher: directFetcher });
      await ollamaFetchShow(config, { method: 'POST', body: '{"name":"gpt-oss:120b"}' }, { fetcher: directFetcher });
    },
  );

  assertEquals(seen, [
    'https://ollama.com/v1/chat/completions',
    'https://ollama.com/v1/responses',
    'https://ollama.com/v1/responses/compact',
    'https://ollama.com/v1/messages',
    'https://ollama.com/v1/embeddings',
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
      await ollamaFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await ollamaFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
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
      await ollamaFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher });
    },
  );
  assertEquals(contentType, 'application/json');
});

test('extraHeaders is a Headers instance and every entry reaches the wire', async () => {
  const { config } = assertOllamaUpstreamRecord(baseRecord);
  let userAgent: string | null = null;
  let forwarded: string | null = null;
  let anthropicBeta: string | null = null;
  await withMockedFetch(
    request => {
      userAgent = request.headers.get('User-Agent');
      forwarded = request.headers.get('Forwarded');
      anthropicBeta = request.headers.get('anthropic-beta');
      return new Response('{}', { status: 200 });
    },
    async () => {
      const extraHeaders = new Headers({
        'User-Agent': 'claude-sdk/1.0',
        'Forwarded': 'for=192.0.2.1;proto=https',
        'anthropic-beta': 'context-1m',
      });
      await ollamaFetchChatCompletions(
        config,
        { method: 'POST', body: '{}' },
        { fetcher: directFetcher, extraHeaders },
      );
    },
  );
  assertEquals(userAgent, 'claude-sdk/1.0');
  assertEquals(forwarded, 'for=192.0.2.1;proto=https');
  assertEquals(anthropicBeta, 'context-1m');
});
