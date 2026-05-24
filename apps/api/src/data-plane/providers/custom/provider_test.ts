import { test } from 'vitest';

import { createCustomProvider } from './provider.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertEquals, assertExists } from '../../../test-assert.ts';
import { buildCustomUpstreamRecord, jsonResponse, setupAppTest, withMockedFetch } from '../../../test-helpers.ts';
import { clearModelsStore, ProviderModelsUnavailableError } from '../models-store.ts';

const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_test',
  provider: 'custom',
  name: 'Custom Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-test',
    supportedEndpoints: ['/chat/completions', '/responses', '/v1/messages'],
  },
  ...overrides,
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

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
        return jsonResponse({ id: 'cc', object: 'chat.completion', model: 'echo', choices: [], usage: {} });
      }
      if (path === '/v1/responses') {
        return jsonResponse({ id: 'r', object: 'response', model: 'echo', output: [], usage: {} });
      }
      if (path === '/v1/messages') {
        return jsonResponse({ id: 'm', type: 'message', role: 'assistant', content: [], model: 'echo', stop_reason: 'end_turn', stop_sequence: null, usage: {} });
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
      const [model] = await provider.getProvidedModels();
      assertEquals(model.id, 'echo');

      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] });
      await provider.callResponses(model, { input: [] });
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callEmbeddings(model, { input: 'hi' });
    },
  );

  assertEquals(bodies['/v1/chat/completions'].stream, true);
  assertEquals(bodies['/v1/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/v1/embeddings'], false);
});

const withMutableNow = async <T>(initial: number, run: (setNow: (value: number) => void) => Promise<T>): Promise<T> => {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;
  try {
    return await run(value => { now = value; });
  } finally {
    Date.now = originalNow;
  }
};

test('Custom provider serves from L2 within the 10 min soft window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    () => { fetches++; return jsonResponse({ object: 'list', data: [{ id: `m-${fetches}` }] }); },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        const first = await provider.getProvidedModels();
        assertEquals(first[0].id, 'm-1');
        setNow(1_000_000 + 5 * 60_000);
        // 5 min exceeds L1 TTL so the second call re-enters the inner closure and serves from L2.
        const second = await provider.getProvidedModels();
        assertEquals(second[0].id, 'm-1');
      });
    },
  );
  assertEquals(fetches, 1);
});

test('Custom provider re-fetches after the 10 min soft window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    () => { fetches++; return jsonResponse({ object: 'list', data: [{ id: `m-${fetches}` }] }); },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        const first = await provider.getProvidedModels();
        assertEquals(first[0].id, 'm-1');
        setNow(1_000_000 + 11 * 60_000);
        clearModelsStore(); // drop L1 so we exercise L2 expiry
        const second = await provider.getProvidedModels();
        assertEquals(second[0].id, 'm-2');
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Custom provider reuses stale L2 on 429 within hard window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    () => {
      fetches++;
      if (fetches === 1) return jsonResponse({ object: 'list', data: [{ id: 'stable' }] });
      return new Response('rate limit', { status: 429 });
    },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        const fresh = await provider.getProvidedModels();
        assertEquals(fresh[0].id, 'stable');
        setNow(1_000_000 + 30 * 60_000);
        clearModelsStore();
        const stale = await provider.getProvidedModels();
        assertEquals(stale[0].id, 'stable');
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Custom provider throws ProviderModelsUnavailableError when fetch fails beyond hard window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  let thrown: unknown;
  await withMockedFetch(
    () => {
      fetches++;
      if (fetches === 1) return jsonResponse({ object: 'list', data: [{ id: 'stable' }] });
      return new Response('rate limit', { status: 429 });
    },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        await provider.getProvidedModels();
        setNow(1_000_000 + 3 * 60 * 60_000); // beyond 2h hard window
        clearModelsStore();
        try { await provider.getProvidedModels(); } catch (e) { thrown = e; }
      });
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 429);
});

test('Custom provider uses configured supportedEndpoints regardless of per-model hints in the /models response', async () => {
  await setupAppTest();
  clearModelsStore();

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
          bearerToken: 'sk-test',
          supportedEndpoints: ['/chat/completions'],
        },
      })).provider;
      const [model] = await provider.getProvidedModels();
      assertEquals([...model.upstreamEndpoints], ['chat_completions']);
      assertEquals(model.kind, 'chat');
    },
  );
});

test('Custom provider projects display_name / created / limits / cost from a floway-style /models response', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-rich',
        type: 'model',
        display_name: 'Rich Model',
        created_at: '2026-04-01T00:00:00Z',
        limits: { max_output_tokens: 8192, max_context_window_tokens: 200000 },
        cost: { input: 3, output: 15, cache_read: 0.3 },
      }],
    }),
    async () => {
      const instance = createCustomProvider(baseRecord({ id: 'up_custom_rich' }));
      const [model] = await instance.provider.getProvidedModels();
      assertEquals(model.display_name, 'Rich Model');
      // 2026-04-01T00:00:00Z → 1774569600
      assertEquals(model.created, Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000));
      assertEquals(model.limits.max_output_tokens, 8192);
      assertEquals(model.limits.max_context_window_tokens, 200000);
      assertEquals(model.cost?.input, 3);
      assertEquals(model.cost?.output, 15);
      assertEquals(model.cost?.cache_read, 0.3);

      const pricing = instance.provider.getPricingForModelKey('m-rich');
      assertEquals(pricing?.input, 3);
      assertEquals(pricing?.output, 15);

      assertEquals(instance.provider.getPricingForModelKey('unknown'), null);
    },
  );
});

test('Custom provider falls back to `name` when display_name is missing (loose OpenAI-compat upstreams)', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-named', name: 'Named Model' }] }),
    async () => {
      const [model] = await createCustomProvider(baseRecord({ id: 'up_custom_named' })).provider.getProvidedModels();
      assertEquals(model.display_name, 'Named Model');
    },
  );
});

test('Custom provider projects gpt-image-* models with kind=image and both image endpoints', async () => {
  await setupAppTest();
  clearModelsStore();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-custom', supportedEndpoints: ['/v1/chat/completions'] },
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
      const provider = createCustomProvider(record).provider;
      const models = await provider.getProvidedModels();
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'gpt-image-2-2026-04-21');
      assertEquals(models[0].kind, 'image');
      assertEquals([...models[0].upstreamEndpoints], ['images_generations', 'images_edits']);
    },
  );
});

test('Custom provider callImagesGenerations posts JSON with model re-injected', async () => {
  await setupAppTest();
  clearModelsStore();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-custom', supportedEndpoints: ['/v1/chat/completions'] },
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
      const provider = createCustomProvider(record).provider;
      const models = await provider.getProvidedModels();
      const result = await provider.callImagesGenerations(models[0], { prompt: 'hi' });
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
  clearModelsStore();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-custom', supportedEndpoints: ['/v1/chat/completions'] },
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
      const provider = createCustomProvider(record).provider;
      const models = await provider.getProvidedModels();
      const form = new FormData();
      form.append('prompt', 'add a kite');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const result = await provider.callImagesEdits(models[0], form);
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.form.get('model'), 'gpt-image-2');
  assertEquals(forwarded.form.get('prompt'), 'add a kite');
  assertEquals(forwarded.form.get('image') instanceof File, true);
});
