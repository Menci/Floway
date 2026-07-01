import { test } from 'vitest';

import { buildCustomUpstreamRecord, setupAppTest } from '../../../test-helpers.ts';
import { directFetcher } from '@floway-dev/provider';
import type { UpstreamRecord } from '@floway-dev/provider';
import { createCustomProvider } from '@floway-dev/provider-custom';
import { jsonResponse, noopUpstreamCallOptions, sseResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_test',
  kind: 'custom',
  name: 'Custom Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-test',
    endpoints: { chatCompletions: {}, responses: {}, messages: {} },
  },
  state: null,
  ...overrides,
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.instance;
  const bodies: Record<string, Record<string, unknown>> = {};

  assertEquals(instance.supportsResponsesItemReference, true);

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'echo', object: 'model' }],
        });
      }

      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/v1/chat/completions') {
        return sseResponse();
      }
      if (path === '/v1/responses') {
        return sseResponse();
      }
      if (path === '/v1/messages') {
        return sseResponse();
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/v1/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'echo' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      assertEquals(providerModel.id, 'echo');
      const model = providerModel; const opts = noopUpstreamCallOptions();

      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callResponses(model, { input: [] }, 'generate', undefined, opts);
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callEmbeddings(model, { input: 'hi' }, undefined, opts);
    },
  );

  assertEquals(bodies['/v1/chat/completions'].stream, true);
  assertEquals(bodies['/v1/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/v1/embeddings'], false);
});

test('Custom provider uses configured endpoints regardless of per-model hints in the /models response', async () => {
  await setupAppTest();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'm-1', supported_endpoints: ['/some/random/path'] }],
    }),
    async () => {
      const provider = createCustomProvider(baseRecord({
        id: 'up_custom_endpoints',
        config: {
          baseUrl: 'https://custom.example.com',
          authStyle: 'bearer',
          apiKey: 'sk-test',
          endpoints: { chatCompletions: {} },
        },
      })).instance;
      const [model] = await provider.getProvidedModels(directFetcher);
      assertEquals(model.endpoints, { chatCompletions: {} });
      assertEquals(model.kind, 'chat');
    },
  );
});

test('Custom provider projects display_name / created / limits / cost from a Floway-style /models response', async () => {
  await setupAppTest();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-rich',
        type: 'model',
        display_name: 'Rich Model',
        created_at: '2026-04-01T00:00:00Z',
        limits: { max_output_tokens: 8192, max_context_window_tokens: 200000 },
        cost: { input: 3, output: 15, input_cache_read: 0.3 },
      }],
    }),
    async () => {
      const instance = createCustomProvider(baseRecord({ id: 'up_custom_rich' }));
      const [model] = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(model.display_name, 'Rich Model');
      assertEquals(model.created, Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000));
      assertEquals(model.limits.max_output_tokens, 8192);
      assertEquals(model.limits.max_context_window_tokens, 200000);
      assertEquals(model.cost?.input, 3);
      assertEquals(model.cost?.output, 15);
      assertEquals(model.cost?.input_cache_read, 0.3);

      const pricing = instance.instance.getPricingForModelKey('m-rich');
      assertEquals(pricing?.input, 3);
      assertEquals(pricing?.output, 15);

      assertEquals(instance.instance.getPricingForModelKey('unknown'), null);
    },
  );
});

test('Custom provider falls back to `name` when display_name is missing (loose OpenAI-compat upstreams)', async () => {
  await setupAppTest();

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-named', name: 'Named Model' }] }),
    async () => {
      const [model] = await createCustomProvider(baseRecord({ id: 'up_custom_named' })).instance.getProvidedModels(directFetcher);
      assertEquals(model.display_name, 'Named Model');
    },
  );
});

test('Custom provider projects gpt-image-* models with kind=image and both image endpoints', async () => {
  await setupAppTest();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk-custom', endpoints: { chatCompletions: {} } },
  });
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2-2026-04-21' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record).instance;
      const models = await provider.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'gpt-image-2-2026-04-21');
      assertEquals(models[0].kind, 'image');
      assertEquals(models[0].endpoints, { imagesGenerations: {}, imagesEdits: {} });
    },
  );
});

test('Custom provider callImagesGenerations posts JSON with model re-injected', async () => {
  await setupAppTest();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk-custom', endpoints: { chatCompletions: {} } },
  });
  let forwarded: { url: string; body: { model?: unknown; prompt?: unknown } } | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      if (url.pathname === '/v1/images/generations') {
        forwarded = { url: request.url, body: await request.json() as Record<string, unknown> };
        return jsonResponse({ data: [{ b64_json: 'abc' }], usage: { input_tokens: 10, output_tokens: 50 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record);
      const models = await provider.instance.getProvidedModels(directFetcher);
      const model = models[0]; const opts = noopUpstreamCallOptions();
      const result = await provider.instance.callImagesGenerations(model, { prompt: 'hi' }, undefined, opts);
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.body.model, 'gpt-image-2');
  assertEquals(forwarded.body.prompt, 'hi');
});

test('Custom provider callImagesEdits forwards multipart body with model field appended', async () => {
  await setupAppTest();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk-custom', endpoints: { chatCompletions: {} } },
  });
  let forwarded: { url: string; form: FormData } | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      if (url.pathname === '/v1/images/edits') {
        forwarded = { url: request.url, form: await request.formData() };
        return jsonResponse({ data: [{ b64_json: 'abc' }], usage: { input_tokens: 5, output_tokens: 20 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record);
      const models = await provider.instance.getProvidedModels(directFetcher);
      const form = new FormData();
      form.append('prompt', 'add a kite');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const model = models[0]; const opts = noopUpstreamCallOptions();
      const result = await provider.instance.callImagesEdits(model, form, undefined, opts);
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.form.get('model'), 'gpt-image-2');
  assertEquals(forwarded.form.get('prompt'), 'add a kite');
  assertEquals(forwarded.form.get('image') instanceof File, true);
});

test('Custom provider with modelsFetch disabled serves only manual models and never fetches', async () => {
  await setupAppTest();

  await withMockedFetch(
    () => { throw new Error('upstream /models must not be fetched when modelsFetch is disabled'); },
    async () => {
      const provider = createCustomProvider(baseRecord({
        id: 'up_custom_manual_only',
        config: {
          baseUrl: 'https://custom.example.com',
          authStyle: 'bearer',
          apiKey: 'sk-test',
          endpoints: { chatCompletions: {} },
          modelsFetch: { enabled: false },
          models: [
            {
              upstreamModelId: 'pinned-chat',
              publicModelId: 'pinned',
              endpoints: { chatCompletions: {} },
              display_name: 'Pinned Chat',
              limits: { max_output_tokens: 4096 },
              cost: { input: 1, output: 2 },
            },
          ],
        },
      })).instance;

      const models = await provider.getProvidedModels(directFetcher);
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'pinned');
      assertEquals(models[0].kind, 'chat');
      assertEquals(models[0].endpoints, { chatCompletions: {} });
      assertEquals(models[0].display_name, 'Pinned Chat');
      assertEquals(models[0].limits.max_output_tokens, 4096);
      assertEquals(models[0].cost?.input, 1);

      const pricing = provider.getPricingForModelKey('pinned-chat');
      assertEquals(pricing?.input, 1);
      assertEquals(pricing?.output, 2);
    },
  );
});

test('Custom provider with a manual override sharing an upstream id wins over the auto copy', async () => {
  await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'shared', cost: { input: 9, output: 9 } },
            { id: 'auto-only' },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(baseRecord({
        id: 'up_custom_override',
        config: {
          baseUrl: 'https://custom.example.com',
          authStyle: 'bearer',
          apiKey: 'sk-test',
          endpoints: { chatCompletions: {} },
          modelsFetch: { enabled: true },
          models: [
            {
              upstreamModelId: 'shared',
              endpoints: { chatCompletions: {} },
              display_name: 'Manual Shared',
              cost: { input: 1, output: 2 },
            },
          ],
        },
      })).instance;

      const models = await provider.getProvidedModels(directFetcher);
      // [manual, ...autoFiltered] — the upstream 'shared' copy is dropped.
      assertEquals(models.map(m => m.id), ['shared', 'auto-only']);
      const shared = models.find(m => m.id === 'shared');
      assertExists(shared);
      assertEquals(shared.display_name, 'Manual Shared');

      // Pricing resolves from the manual config first, not the cached upstream cost.
      const sharedPricing = provider.getPricingForModelKey('shared');
      assertEquals(sharedPricing?.input, 1);
      assertEquals(sharedPricing?.output, 2);

      // Auto models without upstream cost data resolve to null pricing.
      const autoOnly = provider.getPricingForModelKey('auto-only');
      assertEquals(autoOnly, null);
    },
  );
});

test('Custom provider forwards inbound anthropic-beta header through opts.headers', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.instance;
  const seen: Array<string | null> = [];

  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return jsonResponse({ object: 'list', data: [{ id: 'echo', object: 'model' }] });
      seen.push(request.headers.get('anthropic-beta'));
      if (path === '/v1/messages') return sseResponse();
      if (path === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 1 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      const model = providerModel; const opts = noopUpstreamCallOptions();
      // The data plane plumbs `anthropic-beta` straight through `opts.headers`;
      // custom upstreams register no filter interceptor, so whatever arrives on
      // `opts.headers` is what the wire sees.
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, { ...opts, headers: new Headers({ 'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14' }) });
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, { ...opts, headers: new Headers({ 'anthropic-beta': 'oauth-2025-04-20' }) });
      // Empty inbound headers must not emit an anthropic-beta header on the wire.
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
    },
  );

  assertEquals(seen, ['oauth-2025-04-20,interleaved-thinking-2025-05-14', 'oauth-2025-04-20', null, null]);
});
