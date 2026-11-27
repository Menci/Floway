import { test } from 'vitest';

import { customUpstreamModule } from '../src/index.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/upstream';
import { directFetcher } from '@floway-dev/upstream';

interface BuildOptions {
  modelsFetchEnabled?: boolean;
}

const buildCustomUpstream = (options: BuildOptions = {}): UpstreamRecord => ({
  id: 'up_custom',
  kind: 'custom',
  name: 'Custom Provider',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    apiKey: 'sk-test',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: options.modelsFetchEnabled ?? true, authStyle: 'bearer' },
  },
});

test('getModels returns only manual models and never fetches when modelsFetch is disabled', async () => {
  const manualModels: UpstreamModelConfig[] = [
    {
      upstreamModelId: 'manual-only',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {} },
      display_name: 'Manual Only',
      chat: { image_detail_original: true },
    },
  ];
  const record = buildCustomUpstream({ modelsFetchEnabled: false });

  let fetchCalls = 0;
  await withMockedFetch(
    () => {
      fetchCalls++;
      return jsonResponse({ object: 'list', data: [{ id: 'should-not-appear' }] });
    },
    async () => {
      const models = await customUpstreamModule.getModels(record, directFetcher, manualModels);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'manual-only');
      assertEquals(models[0].upstreamModelId, 'manual-only');
      assertEquals(models[0].opaqueBlobCompatibilityScope, { bindToUpstream: true });
      assertEquals(models[0].chat, { image_detail_original: true });
    },
  );
  assertEquals(fetchCalls, 0);
});

test('A manual model whose upstreamModelId matches an auto-fetched id overrides the auto entry', async () => {
  const manualPricing: ModelPricing = { entries: [{ rates: { input_tokens: '1', output_tokens: '2' } }] };
  const manualModels: UpstreamModelConfig[] = [
    {
      upstreamModelId: 'shared-id',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {} },
      display_name: 'Manual Override',
      pricing: manualPricing,
    },
  ];
  const record = buildCustomUpstream();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'shared-id', display_name: 'Auto Version', pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] } },
        { id: 'auto-only' },
      ],
    }),
    async () => {
      const models = await customUpstreamModule.getModels(record, directFetcher, manualModels);
      assertEquals(models.map(m => m.id), ['shared-id', 'auto-only']);
      assertEquals(models[0].display_name, 'Manual Override');
      assertEquals(models[0].pricing, manualPricing);
    },
  );
});

test('a manual model without explicit pricing stays unpriced even when its shadowed auto row has pricing', async () => {
  const autoPricing: ModelPricing = { entries: [{ rates: { input_tokens: '3', output_tokens: '12' } }] };
  const manualModels: UpstreamModelConfig[] = [{ upstreamModelId: 'shared-id', kind: 'chat', endpoints: { openaiChatCompletions: {} } }];
  const record = buildCustomUpstream();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'shared-id', pricing: autoPricing }],
    }),
    async () => {
      const models = await customUpstreamModule.getModels(record, directFetcher, manualModels);
      assertEquals(models.length, 1);
      assertEquals(models[0]?.id, 'shared-id');
      assertEquals(models[0]?.pricing, undefined);
    },
  );
});

test('auto-fetched rerank models stay out of the routable provider catalog', async () => {
  const record = buildCustomUpstream();
  const models = await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'auto-reranker', kind: 'rerank' }, { id: 'chat-model', kind: 'chat' }] }),
    async () => await customUpstreamModule.getModels(record, directFetcher),
  );
  assertEquals(models.map(model => model.id), ['chat-model']);
});

test('scheduled refresh leaves Custom authentication and catalog state alone', async () => {
  await customUpstreamModule.runScheduledTask(buildCustomUpstream(), {
    fetcher: async () => { throw new Error('Custom has no scheduled upstream fetch'); },
  });
});
