import { test } from 'vitest';

import { assertCustomUpstreamRecord, fetchCustomModels } from '../src/index.ts';
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
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'token',
    endpoints: { openaiChatCompletions: {} },
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

test('fetchCustomModels parses the hyper.charm.land OpenAI-compatible shape (top-level limits, flat per-M pricing)', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'deepseek-v4-flash',
        object: 'model',
        created: 1783361967,
        owned_by: 'hyper',
        display_name: 'DeepSeek V4 Flash',
        context_window: 1000000,
        max_output_tokens: 384000,
        capabilities: { vision: false },
        reasoning: { effort_levels: [{ value: 'high', display: 'High' }], default_effort_level: 'high' },
        pricing: { input: 0.2, output: 0.4, cache_create: 0, cache_hit: 0.04 },
      }],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const model = result.data[0];
      assertEquals(model.id, 'deepseek-v4-flash');
      assertEquals(model.display_name, 'DeepSeek V4 Flash');
      assertEquals(model.created, 1783361967);
      assertEquals(model.owned_by, 'hyper');
      assertEquals(model.limits?.max_context_window_tokens, 1000000);
      assertEquals(model.limits?.max_output_tokens, 384000);
      assertEquals(model.chat?.reasoning?.effort?.supported, ['high']);
      assertEquals(model.chat?.reasoning?.effort?.default, 'high');
      assertEquals(model.chat?.modalities, undefined);
      assertEquals(model.pricing?.entries[0]?.rates.input_tokens, '0.0000002');
      assertEquals(model.pricing?.entries[0]?.rates.output_tokens, '0.0000004');
      assertEquals(model.pricing?.entries[0]?.rates.input_cache_write_tokens, '0');
      assertEquals(model.pricing?.entries[0]?.rates.input_cache_read_tokens, '0.00000004');
    },
  );
});

test('fetchCustomModels maps a partial flat pricing block to per-token rates', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', pricing: { input: 1.5, output: 3 } }] }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].pricing?.entries[0]?.rates.input_tokens, '0.0000015');
      assertEquals(result.data[0].pricing?.entries[0]?.rates.output_tokens, '0.000003');
    },
  );
});

test('fetchCustomModels drops flat pricing blocks with unknown keys or non-numeric rates', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list', data: [
        { id: 'unknown-key', pricing: { input: 1, reasoning: 5 } },
        { id: 'nan-rate', pricing: { input: Number.NaN } },
        { id: 'string-rate', pricing: { input: '1' } },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.map(model => model.pricing), [undefined, undefined, undefined]);
    },
  );
});

test('fetchCustomModels merges top-level context limits with a nested limits object', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list', data: [
        { id: 'm-1', context_window: 1000000, max_output_tokens: 384000 },
        { id: 'm-2', context_window: 200000, max_output_tokens: 8192, limits: { max_output_tokens: 4096, max_prompt_tokens: 1000 } },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const topLevel = result.data[0];
      assertEquals(topLevel.limits?.max_context_window_tokens, 1000000);
      assertEquals(topLevel.limits?.max_output_tokens, 384000);
      const merged = result.data[1];
      assertEquals(merged.limits?.max_context_window_tokens, 200000);
      assertEquals(merged.limits?.max_output_tokens, 4096);
      assertEquals(merged.limits?.max_prompt_tokens, 1000);
    },
  );
});

test('fetchCustomModels derives vision and reasoning effort from OpenAI-compat top-level fields', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'vision', capabilities: { vision: true } },
        { id: 'multi', capabilities: { vision: true }, reasoning: { effort_levels: [{ value: 'low', display: 'Low' }, { value: 'high', display: 'High' }], default_effort_level: 'high' } },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data[0].chat?.modalities, { input: ['text', 'image'], output: ['text'] });
      assertEquals(result.data[1].chat?.modalities, { input: ['text', 'image'], output: ['text'] });
      assertEquals(result.data[1].chat?.reasoning?.effort?.supported, ['low', 'high']);
      assertEquals(result.data[1].chat?.reasoning?.effort?.default, 'high');
    },
  );
});

test('fetchCustomModels skips malformed OpenAI-compat reasoning without dropping the model', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'empty-levels', reasoning: { effort_levels: [], default_effort_level: 'high' } },
        { id: 'missing-default', reasoning: { effort_levels: [{ value: 'high', display: 'High' }] } },
        { id: 'default-not-supported', reasoning: { effort_levels: [{ value: 'high', display: 'High' }], default_effort_level: 'xhigh' } },
        { id: 'bad-level-shape', reasoning: { effort_levels: ['high'], default_effort_level: 'high' } },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      assertEquals(result.data.map(model => model.chat), [undefined, undefined, undefined, undefined]);
    },
  );
});

test('fetchCustomModels merges explicit Floway chat with OpenAI-compat derivation (explicit wins per field)', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-1',
        capabilities: { vision: true },
        reasoning: { effort_levels: [{ value: 'low', display: 'Low' }], default_effort_level: 'low' },
        chat: { reasoning: { effort: { supported: ['low', 'medium'], default: 'low' } } },
      }],
    }),
    async () => {
      const result = await fetchCustomModels(config, directFetcher);
      const model = result.data[0];
      assertEquals(model.chat?.modalities, { input: ['text', 'image'], output: ['text'] });
      assertEquals(model.chat?.reasoning?.effort, { supported: ['low', 'medium'], default: 'low' });
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
