import { test } from 'vitest';

import { assertCustomUpstreamRecord, fetchCustomModels } from './index.ts';
import { ProviderModelsUnavailableError, directFetcher, type Fetcher } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const upstreamRecord = () => ({
  id: 'up_custom',
  kind: 'custom' as const,
  name: 'Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'token',
    endpoints: { chatCompletions: {} },
  },
  state: null,
});

test('fetchCustomModels returns the parsed response on 2xx', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1' }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].id, 'm-1');
    },
  );
});

test('fetchCustomModels accepts an Anthropic-shape response with no top-level `object`', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      data: [{ type: 'model', id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', created_at: '2026-01-01T00:00:00Z' }],
      has_more: false,
      first_id: 'claude-opus-4-5',
      last_id: 'claude-opus-4-5',
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].id, 'claude-opus-4-5');
      assertEquals(result.data[0].display_name, 'Claude Opus 4.5');
      assertEquals(result.data[0].created_at, '2026-01-01T00:00:00Z');
    },
  );
});

test('fetchCustomModels reads superset fields (display_name, limits, cost) from our own /models', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      has_more: false,
      first_id: 'm-1',
      last_id: 'm-1',
      data: [
        {
          id: 'm-1',
          object: 'model',
          type: 'model',
          display_name: 'Model One',
          created: 1700000000,
          created_at: '2023-11-14T22:13:20Z',
          owned_by: 'me',
          limits: { max_output_tokens: 4096, max_context_window_tokens: 200000 },
          kind: 'chat',
          cost: { input: 1, output: 2, input_cache_read: 0.1, input_cache_write: 1.25 },
        },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const model = result.data[0];
      assertEquals(model.id, 'm-1');
      assertEquals(model.display_name, 'Model One');
      assertEquals(model.created, 1700000000);
      assertEquals(model.created_at, '2023-11-14T22:13:20Z');
      assertEquals(model.owned_by, 'me');
      assertEquals(model.limits?.max_output_tokens, 4096);
      assertEquals(model.limits?.max_context_window_tokens, 200000);
      assertEquals(model.cost?.input, 1);
      assertEquals(model.cost?.output, 2);
      assertEquals(model.cost?.input_cache_read, 0.1);
      assertEquals(model.cost?.input_cache_write, 1.25);
    },
  );
});

test('fetchCustomModels keeps a `cost` block with any subset of billing dimensions', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', cost: { input: 1 } }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].cost, { input: 1 });
    },
  );
});

test('fetchCustomModels drops a `cost` block with no recognized dimensions', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', cost: { reasoning: 5 } }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].cost, undefined);
    },
  );
});

test('fetchCustomModels skips entries whose id is not a non-empty string', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'ok' }, { id: '' }, { id: 123 }, { display_name: 'no id' }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].id, 'ok');
    },
  );
});

test('fetchCustomModels throws ProviderModelsUnavailableError with httpResponse on non-2xx', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => new Response('rate limit', { status: 429, headers: { 'retry-after': '5' } }),
    async () => {
      try { await fetchCustomModels(config, directFetcher); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 429);
  assertEquals(thrown.httpResponse?.body, 'rate limit');
  assertEquals(thrown.httpResponse?.headers.get('retry-after'), '5');
});

test('fetchCustomModels throws ProviderModelsUnavailableError with null httpResponse on network error', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => { throw new TypeError('network down'); },
    async () => {
      try { await fetchCustomModels(config, directFetcher); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
});

test('fetchCustomModels throws ProviderModelsUnavailableError with null httpResponse on shape error', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: 'oops' }),
    async () => {
      try { await fetchCustomModels(config, directFetcher); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
});

test('fetchCustomModels routes the catalog GET through the injected fetcher, not globalThis.fetch', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const injected: Fetcher = (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url: String(url), authorization: headers.get('authorization') });
    return Promise.resolve(jsonResponse({ object: 'list', data: [{ id: 'injected-model' }] }));
  };
  // No withMockedFetch — assert by construction that the injected fetcher
  // (not the runtime's globalThis.fetch) carried the request.
  const result = await fetchCustomModels(config, injected);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://custom.example.com/v1/models');
  assertEquals(calls[0].authorization, 'Bearer token');
  assertEquals(result.data[0].id, 'injected-model');
});

test('fetchCustomModels reads chat metadata from Floway-shaped upstreams', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-1',
        chat: {
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          reasoning: {
            effort: {
              supported: ['low', 'medium', 'high'],
              default: 'medium',
            },
          },
        },
      }],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const model = result.data[0];
      assertEquals(model.id, 'm-1');
      assertEquals(model.chat?.modalities?.input, ['text', 'image']);
      assertEquals(model.chat?.modalities?.output, ['text']);
      assertEquals(model.chat?.reasoning?.effort?.supported, ['low', 'medium', 'high']);
      assertEquals(model.chat?.reasoning?.effort?.default, 'medium');
    },
  );
});

test('fetchCustomModels skips malformed chat field without error', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-1',
        chat: 'malformed',
      }],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const model = result.data[0];
      assertEquals(model.id, 'm-1');
      assertEquals(model.chat, undefined);
    },
  );
});

test('fetchCustomModels skips missing chat field', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'm-1' }],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const model = result.data[0];
      assertEquals(model.id, 'm-1');
      assertEquals(model.chat, undefined);
    },
  );
});
