import { test } from 'vitest';

import { createCustomProvider } from './provider.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

interface BuildOptions {
  modelsFetchEnabled?: boolean;
  models?: UpstreamModelConfig[];
}

const buildCustomUpstream = (options: BuildOptions = {}): UpstreamRecord => ({
  id: 'up_custom',
  kind: 'custom',
  name: 'Custom Provider',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  color: null,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-test',
    endpoints: { chatCompletions: {} },
    modelsFetch: { enabled: options.modelsFetchEnabled ?? true },
    models: options.models ?? [],
  },
});

test('getProvidedModels returns only manual models and never fetches when modelsFetch is disabled', async () => {
  const record = buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [
      {
        upstreamModelId: 'manual-only',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
        display_name: 'Manual Only',
      },
    ],
  });
  const instance = createCustomProvider(record);

  let fetchCalls = 0;
  await withMockedFetch(
    () => {
      fetchCalls++;
      return jsonResponse({ object: 'list', data: [{ id: 'should-not-appear' }] });
    },
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'manual-only');
    },
  );
  assertEquals(fetchCalls, 0);
});

test('getProvidedModels merges manual models in front of auto-fetched models when fetch succeeds', async () => {
  const record = buildCustomUpstream({
    models: [
      {
        upstreamModelId: 'manual-extra',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
        display_name: 'Manual Extra',
      },
    ],
  });
  const instance = createCustomProvider(record);

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'auto-1' }, { id: 'auto-2' }] }),
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.map(m => m.id), ['manual-extra', 'auto-1', 'auto-2']);
    },
  );
});

test('getProvidedModels rethrows when the upstream fetch fails — no fallback inside the provider', async () => {
  const record = buildCustomUpstream();
  const instance = createCustomProvider(record);

  await withMockedFetch(
    () => new Response('rate limited', { status: 429 }),
    async () => {
      await assertRejects(() => instance.instance.getProvidedModels(directFetcher));
    },
  );
});

test('getProvidedModels carries pricing on auto models', async () => {
  const record = buildCustomUpstream();
  const instance = createCustomProvider(record);

  const upstreamPricing: ModelPricing = { entries: [{ rates: { input: 3, output: 12 } }] };
  const models = await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'priced-model', pricing: upstreamPricing }],
    }),
    async () => {
      return await instance.instance.getProvidedModels(directFetcher);
    },
  );

  assertEquals(models[0]?.pricing, upstreamPricing);
});

test('A manual model whose upstreamModelId matches an auto-fetched id overrides the auto entry', async () => {
  const manualPricing: ModelPricing = { entries: [{ rates: { input: 1, output: 2 } }] };
  const record = buildCustomUpstream({
    models: [
      {
        upstreamModelId: 'shared-id',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
        display_name: 'Manual Override',
        pricing: manualPricing,
      },
    ],
  });
  const instance = createCustomProvider(record);

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [
        { id: 'shared-id', display_name: 'Auto Version', pricing: { entries: [{ rates: { input: 99, output: 99 } }] } },
        { id: 'auto-only' },
      ],
    }),
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.map(m => m.id), ['shared-id', 'auto-only']);
      assertEquals(models[0].display_name, 'Manual Override');
      assertEquals(models[0].pricing, manualPricing);
    },
  );
});

test('a manual model without explicit pricing inherits pricing from its shadowed auto row', async () => {
  const inheritedPricing: ModelPricing = { entries: [{ rates: { input: 3, output: 12 } }] };
  const instance = createCustomProvider(buildCustomUpstream({
    models: [{ upstreamModelId: 'shared-id', kind: 'chat', endpoints: { chatCompletions: {} } }],
  }));

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'shared-id', pricing: inheritedPricing }],
    }),
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0]?.id, 'shared-id');
      assertEquals(models[0]?.pricing, inheritedPricing);
    },
  );
});
