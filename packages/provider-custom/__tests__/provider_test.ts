import { test } from 'vitest';

import { createCustomProvider } from '../src/provider.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, assertRejects, jsonResponse, noopMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

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
  modelsCache: null,
  hue: 210,
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

test('manual runtime kind follows transcription endpoints when stored kind is stale', async () => {
  const instance = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'raw-transcriber',
      kind: 'chat',
      endpoints: { audioTranscriptions: {} },
    }],
  }));
  const [model] = await instance.instance.getProvidedModels(directFetcher);
  assertEquals(model?.kind, 'transcription');
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
        noopUpstreamCallOptions(),
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
        noopUpstreamCallOptions(),
      );
    },
  );
  assertEquals(requestUrl, 'https://custom.example.com/workspace/rerank');
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const provider = createCustomProvider(buildCustomUpstream()).instance;
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
      const [model] = await provider.getProvidedModels(directFetcher);
      assertExists(model);
      const opts = noopUpstreamCallOptions();
      const messagesOpts = noopMessagesUpstreamCallOptions({ anthropicBeta: ['context-1m', 'advanced-tool-use'] });
      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callResponses(model, { input: [] }, 'generate', undefined, opts);
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, messagesOpts);
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, messagesOpts);
      await provider.callEmbeddings(model, { input: 'hi' }, undefined, opts);
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
  assertEquals(betas['/v1/responses'], null);
  assertEquals(betas['/v1/embeddings'], null);
});

test('Custom provider uses configured endpoints regardless of per-model hints in the /models response', async () => {
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', supported_endpoints: ['/some/random/path'] }] }),
    async () => {
      const provider = createCustomProvider(buildCustomUpstream()).instance;
      const [model] = await provider.getProvidedModels(directFetcher);
      assertEquals(model.endpoints, { chatCompletions: {} });
      assertEquals(model.kind, 'chat');
    },
  );
});

test('Custom provider projects display_name / created / limits / pricing from a Floway-shaped /models response', async () => {
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-rich',
        type: 'model',
        display_name: 'Rich Model',
        created_at: '2026-04-01T00:00:00Z',
        limits: { max_output_tokens: 8192, max_context_window_tokens: 200000 },
        pricing: { entries: [{ rates: { input_tokens: '3', output_tokens: '15', input_cache_read_tokens: '0.3' } }] },
      }],
    }),
    async () => {
      const [model] = await createCustomProvider(buildCustomUpstream()).instance.getProvidedModels(directFetcher);
      assertEquals(model.display_name, 'Rich Model');
      assertEquals(model.created, Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000));
      assertEquals(model.limits.max_output_tokens, 8192);
      assertEquals(model.limits.max_context_window_tokens, 200000);
      assertEquals(model.pricing?.entries[0]?.rates.input_tokens, '3');
      assertEquals(model.pricing?.entries[0]?.rates.output_tokens, '15');
      assertEquals(model.pricing?.entries[0]?.rates.input_cache_read_tokens, '0.3');
    },
  );
});

test('Custom provider falls back to `name` when display_name is missing (loose OpenAI-compat upstreams)', async () => {
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-named', name: 'Named Model' }] }),
    async () => {
      const [model] = await createCustomProvider(buildCustomUpstream()).instance.getProvidedModels(directFetcher);
      assertEquals(model.display_name, 'Named Model');
    },
  );
});

test('Custom provider callImagesGenerations posts JSON with model re-injected', async () => {
  let forwarded: { url: string; body: { model?: unknown; prompt?: unknown } } | undefined;
  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      if (path === '/v1/images/generations') {
        forwarded = { url: request.url, body: await request.json() as Record<string, unknown> };
        return jsonResponse({ data: [{ b64_json: 'abc' }], usage: { input_tokens: 10, output_tokens: 50 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(buildCustomUpstream());
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const result = await provider.instance.callImagesGenerations(model, { prompt: 'hi' }, undefined, noopUpstreamCallOptions());
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.body.model, 'gpt-image-2');
  assertEquals(forwarded.body.prompt, 'hi');
});

test('Custom provider callAlphaSearch posts JSON to /v1/alpha/search with the upstream model', async () => {
  let forwarded: { url: string; body: Record<string, unknown> } | undefined;
  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-search' }] });
      if (path === '/v1/alpha/search') {
        forwarded = { url: request.url, body: await request.json() as Record<string, unknown> };
        return jsonResponse({ encrypted_output: null, output: 'result', results: [] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(buildCustomUpstream());
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const result = await provider.instance.callAlphaSearch(
        model,
        { id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } },
        undefined,
        noopUpstreamCallOptions(),
      );
      assertEquals(result.response.status, 200);
      assertEquals(result.modelKey, 'gpt-search');
    },
  );
  assertEquals(forwarded, {
    url: 'https://custom.example.com/v1/alpha/search',
    body: {
      id: 'search-session',
      commands: { search_query: [{ q: 'Floway' }] },
      model: 'gpt-search',
    },
  });
});

test('Custom provider with modelsFetch disabled serves only manual models and never fetches', async () => {
  const provider = createCustomProvider(buildCustomUpstream({
    modelsFetchEnabled: false,
    models: [{
      upstreamModelId: 'pinned-chat',
      publicModelId: 'pinned',
      kind: 'chat',
      endpoints: { chatCompletions: {} },
      display_name: 'Pinned Chat',
      limits: { max_output_tokens: 4096 },
      pricing: { entries: [{ rates: { input_tokens: '1', output_tokens: '2' } }] },
    }],
  })).instance;

  await withMockedFetch(
    () => { throw new Error('upstream /models must not be fetched when modelsFetch is disabled'); },
    async () => {
      const models = await provider.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'pinned');
      assertEquals(models[0].kind, 'chat');
      assertEquals(models[0].endpoints, { chatCompletions: {} });
      assertEquals(models[0].display_name, 'Pinned Chat');
      assertEquals(models[0].limits.max_output_tokens, 4096);
      assertEquals(models[0].pricing?.entries[0]?.rates.input_tokens, '1');
    },
  );
});

test('Custom provider with a manual override sharing an upstream id wins over the auto copy', async () => {
  const provider = createCustomProvider(buildCustomUpstream({
    models: [{
      upstreamModelId: 'shared',
      kind: 'chat',
      endpoints: { chatCompletions: {} },
      display_name: 'Manual Shared',
      pricing: { entries: [{ rates: { input_tokens: '1', output_tokens: '2' } }] },
    }],
  })).instance;

  await withMockedFetch(
    request => {
      if (new URL(request.url).pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'shared', pricing: { entries: [{ rates: { input_tokens: '9', output_tokens: '9' } }] } },
            { id: 'auto-only' },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels(directFetcher);
      assertEquals(models.map(model => model.id), ['shared', 'auto-only']);
      const shared = models.find(model => model.id === 'shared');
      assertExists(shared);
      assertEquals(shared.display_name, 'Manual Shared');
      assertEquals(shared.pricing?.entries[0]?.rates.input_tokens, '1');
      assertEquals(shared.pricing?.entries[0]?.rates.output_tokens, '2');
      assertEquals(models.find(model => model.id === 'auto-only')?.pricing, undefined);
    },
  );
});
