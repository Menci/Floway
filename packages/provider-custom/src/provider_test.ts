import { test } from 'vitest';

import { createCustomProvider } from './provider.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, assertExists, assertRejects, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

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

  const upstreamPricing: ModelPricing = { entries: [{ rates: { input_tokens: '3', output_tokens: '12' } }] };
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
  const manualPricing: ModelPricing = { entries: [{ rates: { input_tokens: '1', output_tokens: '2' } }] };
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
        { id: 'shared-id', display_name: 'Auto Version', pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] } },
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
  const inheritedPricing: ModelPricing = { entries: [{ rates: { input_tokens: '3', output_tokens: '12' } }] };
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

test('auto-fetched rerank models stay out of the routable provider catalog', async () => {
  const instance = createCustomProvider(buildCustomUpstream());
  const models = await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'auto-reranker', kind: 'rerank' }, { id: 'chat-model', kind: 'chat' }] }),
    async () => await instance.instance.getProvidedModels(directFetcher),
  );
  assertEquals(models.map(model => model.id), ['chat-model']);
});

test('manual runtime kind follows rerank endpoints when stored kind is stale', async () => {
  const instance = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'raw-reranker',
      kind: 'chat',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }],
  }));
  const [model] = await instance.instance.getProvidedModels(directFetcher);
  assertEquals(model?.kind, 'rerank');
  assertEquals(model?.rerankTarget, { protocol: 'cohere-v2' });
});

test('callRerank uses the model target protocol, raw model id, and canonical path', async () => {
  const instance = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'raw-reranker',
      publicModelId: 'public-reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }],
  }));
  const [model] = await instance.instance.getProvidedModels(directFetcher);
  assertExists(model);
  let requestUrl: string | undefined;
  let requestBody: unknown;
  await withMockedFetch(
    async request => {
      requestUrl = request.url;
      requestBody = await request.json();
      return jsonResponse({ results: [] });
    },
    async () => {
      const result = await instance.instance.callRerank(
        model,
        parseRerankRequest('cohere-v1', { model: 'public-reranker', query: 'query', documents: ['one'], top_n: 1 }).request,
        undefined,
        { fetcher: directFetcher, waitUntil: () => {}, headers: new Headers(), wrapUpstreamCall: identityWrapUpstreamCall },
      );
      assertEquals(result.target, { protocol: 'cohere-v2' });
      assertEquals(result.modelKey, 'raw-reranker');
    },
  );
  assertEquals(requestUrl, 'https://custom.example.com/v2/rerank');
  assertEquals(requestBody, { model: 'raw-reranker', query: 'query', documents: ['one'], top_n: 1 });
});

test('callRerank honors the per-model path without adding an upstream path override', async () => {
  const instance = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'raw-reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'dashscope-native', path: '/workspace/rerank' },
    }],
  }));
  const [model] = await instance.instance.getProvidedModels(directFetcher);
  assertExists(model);
  let requestUrl: string | undefined;
  await withMockedFetch(
    request => {
      requestUrl = request.url;
      return jsonResponse({ output: { results: [] } });
    },
    async () => {
      await instance.instance.callRerank(
        model,
        parseRerankRequest('jina-v1', { model: 'raw-reranker', query: 'query', documents: ['one'] }).request,
        undefined,
        { fetcher: directFetcher, waitUntil: () => {}, headers: new Headers(), wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );
  assertEquals(requestUrl, 'https://custom.example.com/workspace/rerank');
});
