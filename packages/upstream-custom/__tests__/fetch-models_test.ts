import { test } from 'vitest';

import { assertCustomUpstreamRecord, fetchCustomModels, projectCustomModels, type CustomAuthStyle } from '../src/index.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';
import { directFetcher } from '@floway-dev/upstream';

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
      assertEquals(model.limits, { max_output_tokens: 4096, max_context_window_tokens: 200000 });
      assertEquals(model.pricing, { entries: [{ rates: { input_tokens: '1', output_tokens: '2', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25' } }] });
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

test('a published speech kind supplies the speech endpoint without a manual model', async () => {
  const record = upstreamRecord();
  const { config } = assertCustomUpstreamRecord(record);
  const response = await fetchCustomModels(config, async () => jsonResponse({ data: [{ id: 'public-tts', kind: 'speech' }] }));
  assertEquals(response.data, [{ id: 'public-tts', kind: 'speech' }]);
  const models = projectCustomModels(record, [], response);
  assertEquals(models.map(model => [model.id, model.kind, model.endpoints]), [['public-tts', 'speech', { openaiAudioSpeech: {} }]]);
});

test.each([
  { authStyle: 'bearer', expected: [['authorization', 'Bearer token']] },
  { authStyle: 'x-api-key', expected: [['anthropic-version', '2023-06-01'], ['x-api-key', 'token']] },
  { authStyle: 'x-goog-api-key', expected: [['x-goog-api-key', 'token']] },
] satisfies { authStyle: CustomAuthStyle; expected: string[][] }[])('fetches the catalog with $authStyle independently of inference authority', async ({ authStyle, expected }) => {
  const record = upstreamRecord();
  const { config } = assertCustomUpstreamRecord({
    ...record,
    config: {
      ...record.config,
      endpoints: { anthropicMessages: {} },
      modelsFetch: { enabled: true, authStyle, endpoint: '/catalog' },
    },
  });
  const models = await fetchCustomModels(config, async (url, init) => {
    assertEquals(url, 'https://custom.example.com/catalog');
    assertEquals(init.method, 'GET');
    assertEquals([...new Headers(init.headers)], expected);
    return jsonResponse({ data: [{ id: 'listed-model' }] });
  });
  assertEquals(models.data, [{ id: 'listed-model' }]);
});
