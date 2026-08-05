import { test } from 'vitest';

import { assertCustomUpstreamRecord, fetchCustomModels } from '../src/index.ts';
import { ProviderModelsUnavailableError, directFetcher, type Fetcher } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

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
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'token',
    endpoints: { chatCompletions: {} },
    ingressHeadersRules: [],
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

test('fetchCustomModels follows Anthropic cursor pages and deduplicates their models', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  config.modelsFetch.endpoint = '/v1/models?region=us';
  const afterIds: Array<string | null> = [];
  const limits: Array<string | null> = [];
  const regions: Array<string | null> = [];
  await withMockedFetch(
    request => {
      const afterId = new URL(request.url).searchParams.get('after_id');
      afterIds.push(afterId);
      limits.push(new URL(request.url).searchParams.get('limit'));
      regions.push(new URL(request.url).searchParams.get('region'));
      return afterId === null
        ? jsonResponse({
            data: [{ type: 'model', id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', created_at: '2026-01-01T00:00:00Z' }],
            has_more: true,
            first_id: 'claude-opus-4-5',
            last_id: 'claude-opus-4-5',
          })
        : jsonResponse({
            data: [
              { type: 'model', id: 'claude-opus-4-5', display_name: 'duplicate' },
              { type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
            ],
            has_more: false,
            first_id: 'claude-opus-4-5',
            last_id: 'claude-sonnet-4-5',
          });
    },
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(afterIds, [null, 'claude-opus-4-5']);
      assertEquals(limits, [null, '1000']);
      assertEquals(regions, ['us', 'us']);
      assertEquals(result.data.map(model => model.id), ['claude-opus-4-5', 'claude-sonnet-4-5']);
      assertEquals(result.data[0].id, 'claude-opus-4-5');
      assertEquals(result.data[0].display_name, 'Claude Opus 4.5');
      assertEquals(result.data[0].created_at, '2026-01-01T00:00:00Z');
    },
  );
});

test('fetchCustomModels reads superset fields (display_name, limits, pricing) from Floway-shaped upstreams', async () => {
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
          pricing: { entries: [{ rates: { input_tokens: '1', output_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25' } }] },
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
      assertEquals(model.pricing?.entries[0]?.rates.input_tokens, '1');
      assertEquals(model.pricing?.entries[0]?.rates.output_tokens, '2');
      assertEquals(model.pricing?.entries[0]?.rates.input_cache_read_tokens, '0.1');
      assertEquals(model.pricing?.entries[0]?.rates.input_cache_write_tokens, '1.25');
    },
  );
});

test('fetchCustomModels keeps a `pricing` block with any subset of billing metrics', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', pricing: { entries: [{ rates: { input_tokens: '1' } }] } }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].pricing, { entries: [{ rates: { input_tokens: '1' } }] });
    },
  );
});

test('fetchCustomModels keeps models but omits one malformed pricing block', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list', data: [
        { id: 'bad-pricing', pricing: { entries: [{ rates: { input_tokens: '-1' }, selector: { unknown: 'x' } }] } },
        { id: 'good-pricing', pricing: { entries: [{ rates: { input_tokens: '1' } }] } },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.map(model => model.id), ['bad-pricing', 'good-pricing']);
      assertEquals(result.data[0].pricing, undefined);
      assertEquals(result.data[1].pricing, { entries: [{ rates: { input_tokens: '1' } }] });
    },
  );
});

test('fetchCustomModels omits complete pricing blocks instead of salvaging valid fragments', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list', data: [
        {
          id: 'bad-rate',
          pricing: { entries: [{ rates: { input_tokens: '1', output_tokens: 'unknown' } }] },
        },
        {
          id: 'bad-entry',
          pricing: { entries: [{ rates: { input_tokens: '1' } }, { rates: null }] },
        },
        {
          id: 'bad-selector',
          pricing: { entries: [{ rates: { input_tokens: '1' }, selector: 'priority' }] },
        },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.map(model => model.pricing), [undefined, undefined, undefined]);
    },
  );
});

test('fetchCustomModels drops a `pricing` block with no recognized metrics', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', pricing: { reasoning: 5 } }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].pricing, undefined);
    },
  );
});

test('fetchCustomModels drops pricing blocks with unknown rates or top-level fields', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'unknown-rate', pricing: { entries: [{ rates: { input_tokens: '1', reasoning: 2 } }] } },
        { id: 'unknown-field', pricing: { scale: '1000000', entries: [{ rates: { input_tokens: '1' } }] } },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.map(model => model.pricing), [undefined, undefined]);
    },
  );
});

test('fetchCustomModels skips malformed and duplicate ids and unsafe timestamps', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'ok', display_name: 'first', created: Number.MAX_VALUE },
        { id: 'ok', display_name: 'duplicate' },
        { id: '' },
        { id: 123 },
        { display_name: 'no id' },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].id, 'ok');
      assertEquals(result.data[0].display_name, 'first');
      assertEquals(result.data[0].created, undefined);
    },
  );
});

test('fetchCustomModels rejects cursor cycles without returning a partial catalog', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let calls = 0;
  const error = await withMockedFetch(
    () => {
      calls++;
      return jsonResponse({ data: [{ id: `model-${calls}` }], has_more: true, last_id: 'repeated' });
    },
    async () => await assertRejects(() => fetchCustomModels(config, directFetcher), ProviderModelsUnavailableError),
  );
  assertEquals(calls, 2);
  assertEquals((error.cause as Error).message, 'Custom /models pagination repeated cursor "repeated"');
});

test('fetchCustomModels bounds unique-cursor pagination', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls++;
    return Promise.resolve(jsonResponse({ data: [{ id: `model-${calls}` }], has_more: true, last_id: `cursor-${calls}` }));
  };
  const error = await assertRejects(() => fetchCustomModels(config, fetcher), ProviderModelsUnavailableError);
  assertEquals(calls, 32);
  assertEquals((error.cause as Error).message, 'Custom /models pagination exceeded 32 pages');
});

test('fetchCustomModels bounds the number of models retained for caching', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  const fetcher: Fetcher = () => Promise.resolve(jsonResponse({
    data: Array.from({ length: 4097 }, (_, index) => ({ id: `model-${index}` })),
  }));
  const error = await assertRejects(() => fetchCustomModels(config, fetcher), ProviderModelsUnavailableError);
  assertEquals((error.cause as Error).message, 'Custom /models catalog exceeded 4096 models');
});

test('fetchCustomModels throws ProviderModelsUnavailableError with httpResponse on non-2xx', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  let calls = 0;
  await withMockedFetch(
    () => ++calls === 1
      ? jsonResponse({ data: [{ id: 'first-page' }], has_more: true, last_id: 'first-page' })
      : new Response('rate limit', { status: 429, headers: { 'retry-after': '5' } }),
    async () => {
      try { await fetchCustomModels(config, directFetcher); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(calls, 2);
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
  for (const body of [
    { object: 'list', data: 'oops' },
    { data: [{ id: 'model' }], has_more: true, last_id: null },
    { data: [{ id: 'model' }], has_more: 'yes', last_id: 'model' },
  ]) {
    const error = await withMockedFetch(
      () => jsonResponse(body),
      async () => await assertRejects(() => fetchCustomModels(config, directFetcher), ProviderModelsUnavailableError),
    );
    assertEquals((error as ProviderModelsUnavailableError).httpResponse, null);
  }
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
