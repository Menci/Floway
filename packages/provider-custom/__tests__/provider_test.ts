import { expect, test } from 'vitest';

import { callCustom, customInput } from './pipeline-fixture.ts';
import { customPipelines } from '../src/pipelines.ts';
import { createCustomProvider } from '../src/provider.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

interface BuildOptions {
  ingressHeadersRules?: { key: string; value: string | null }[];
  modelsFetchEnabled?: boolean;
  models?: UpstreamModelConfig[];
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
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    apiKey: 'sk-test',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: options.ingressHeadersRules ?? [],
    modelsFetch: { enabled: options.modelsFetchEnabled ?? true, authStyle: 'bearer' },
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
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Manual Only',
        chat: { image_detail_original: true },
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
      assertEquals(models[0].upstreamModelId, 'manual-only');
      assertEquals(models[0].opaqueBlobCompatibilityScope, { bindToUpstream: true });
      assertEquals(models[0].chat, { image_detail_original: true });
    },
  );
  assertEquals(fetchCalls, 0);
});

test('A manual model whose upstreamModelId matches an auto-fetched id overrides the auto entry', async () => {
  const manualPricing: ModelPricing = { entries: [{ rates: { input_tokens: '1', output_tokens: '2' } }] };
  const record = buildCustomUpstream({
    models: [
      {
        upstreamModelId: 'shared-id',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
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
    models: [{ upstreamModelId: 'shared-id', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
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

test('rerank uses the model target protocol, raw model id, and canonical path', async () => {
  const record = buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'raw-reranker',
      publicModelId: 'public-reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }],
  });
  const instance = createCustomProvider(record);
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
      const { request } = parseRerankRequest('cohere-v1', { model: 'public-reranker', query: 'query', documents: ['one'], top_n: 1 });
      const result = await callCustom(customPipelines.rerank, customInput(record, model, request));
      assertEquals(result['response.rerank'], { kind: 'ok', target: { protocol: 'cohere-v2' } });
      assertEquals(result['response.modelKey'], 'raw-reranker');
    },
  );
  assertEquals(requestUrl, 'https://custom.example.com/v2/rerank');
  assertEquals(requestBody, { model: 'raw-reranker', query: 'query', documents: ['one'], top_n: 1 });
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const record = buildCustomUpstream();
  const provider = createCustomProvider(record);
  const bodies: Record<string, Record<string, unknown>> = {};
  const betas: Record<string, string | null> = {};

  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'echo', object: 'model' }] });
      }

      bodies[path] = (await request.json()) as Record<string, unknown>;
      betas[path] = request.headers.get('anthropic-beta');
      if (path === '/v1/chat/completions' || path === '/v1/responses' || path === '/v1/messages') {
        return sseResponse();
      }
      if (path === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 1 });
      if (path === '/v1/embeddings') return jsonResponse({ object: 'list', data: [], model: 'echo' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      assertExists(model);
      const anthropic = {
        ...customInput(record, model, { max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] }),
        'request.anthropicBeta': ['context-1m', 'advanced-tool-use'],
      };
      await callCustom(customPipelines.openaiChatCompletions, customInput(record, model, { messages: [{ role: 'user', content: 'hi' }] }));
      await callCustom(customPipelines.openaiResponses, { ...customInput(record, model, { input: [] }), 'request.action': 'generate' });
      await callCustom(customPipelines.anthropicMessages, anthropic);
      await callCustom(customPipelines.anthropicMessagesCountTokens, anthropic);
      await callCustom(customPipelines.openaiEmbeddings, customInput(record, model, { input: 'hi' }));
    },
  );

  assertEquals(bodies['/v1/chat/completions'].stream, true);
  assertEquals(bodies['/v1/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/v1/embeddings'], false);
  assertEquals(betas['/v1/messages'], 'context-1m,advanced-tool-use');
  assertEquals(betas['/v1/messages/count_tokens'], 'context-1m,advanced-tool-use');
  assertEquals(betas['/v1/chat/completions'], null);
});

test('a non-2xx chat response returns the upstream JSON error and metadata', async () => {
  const record = buildCustomUpstream();
  const error = { error: { type: 'rate_limit', message: 'try later' } };
  const result = await callCustom(
    customPipelines.openaiChatCompletions,
    customInput(record, stubProviderModel(), { messages: [] }),
    async () => new Response(JSON.stringify(error), { status: 429, headers: { 'retry-after': '5' } }),
  );

  expect(result['response.openaiChatCompletions']).toEqual({ kind: 'error', source: 'upstream', error });
  expect(result['response.http']).toMatchObject({ status: 429, headers: expect.arrayContaining([['retry-after', '5']]), body: null });
});

test('a transport failure while reading the upstream error body returns a 502 outcome', async () => {
  const record = buildCustomUpstream();
  const result = await callCustom(
    customPipelines.openaiEmbeddings,
    customInput(record, stubProviderModel(), { input: 'hi' }),
    async () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    }), { status: 503 }),
  );

  expect(result['response.openaiEmbeddings']).toEqual({
    kind: 'error', source: 'upstream', error: { error: { type: 'upstream_transport_error', message: 'connection reset' } },
  });
  expect(result['response.http']).toMatchObject({ status: 502, body: null, transportError: { message: 'connection reset' } });
});

test('rerank rejects invalid success JSON and preserves bytes for valid success JSON', async () => {
  const record = buildCustomUpstream();
  const model = { ...stubProviderModel(), rerankTarget: { protocol: 'cohere-v2' as const } };
  const { request } = parseRerankRequest('cohere-v1', { model: 'm', query: 'query', documents: ['one'] });
  const facts = customInput(record, model, request);
  const invalid = await callCustom(customPipelines.rerank, facts, async () => new Response('<html>'));
  const raw = '{ "results": [{ "index": 0, "relevance_score": 1.0 }] }';
  const valid = await callCustom(customPipelines.rerank, facts, async () => new Response(raw));

  expect(invalid['response.http'].status).toBe(502);
  expect(invalid['response.rerank']).toMatchObject({
    kind: 'error', source: 'upstream', error: { error: { type: 'upstream_invalid_json' } },
  });
  expect(valid['response.rerank']).toEqual({ kind: 'ok', target: { protocol: 'cohere-v2' } });
  expect(valid.body.utf8()).toBe(raw);
});

test('OpenAI Completions preserves a successful non-JSON upstream response', async () => {
  const result = await callCustom(
    customPipelines.openaiCompletions,
    customInput(buildCustomUpstream(), stubProviderModel(), { prompt: 'hi' }),
    async () => new Response('raw upstream body', { headers: { 'content-type': 'text/plain' } }),
  );

  expect(result['response.openaiCompletions']).toEqual({ kind: 'ok' });
  expect(result.body.utf8()).toBe('raw upstream body');
});
