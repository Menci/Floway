import { test } from 'vitest';

import { assertCustomUpstreamRecord, fetchCustomModels } from '../src/index.ts';
import { ProviderModelsUnavailableError, directFetcher } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const upstreamRecord = () => ({
  id: 'up_custom',
  kind: 'custom' as const,
  name: 'Custom',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
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
    apiKey: 'token',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
  },
  state: null,
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

test('fetchCustomModels reads superset fields from Floway-shaped upstreams', async () => {
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
          opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'shared-model' },
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
      assertEquals(model.opaqueBlobCompatibilityScope, { bindToUpstream: false, key: 'shared-model' });
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
  assertEquals(thrown.displayResponse, {
    status: 429,
    headers: [['content-type', 'text/plain;charset=UTF-8'], ['retry-after', '5']],
    body: 'rate limit',
  });
});
