import { expect, test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, flushAsyncWork, MOCKED_FETCH_EGRESS, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

test('/v1/images/generations rejects model on custom upstream without /images/generations capability', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  // Chat-only custom upstream. Its /models response advertises gpt-4o
  // (which the id heuristic leaves as the chat fallback), so the resolver
  // returns `sawModel=true` with zero candidates after the kind filter
  // — distinguishing wrong-kind from unknown-id at the resolver layer.
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://chat.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-chat',
      endpoints: { openaiChatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-4o', prompt: 'hi' }),
      });
      assertEquals(response.status, 400);
    },
  );
});

test('/v1/images/generations forwards a JSON request through a custom upstream and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_images',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
    },
  }));

  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/generations') {
        forwarded = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 10, output_tokens: 50 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space' }),
      });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: { b64_json: string }[] };
      assertEquals(body.data[0].b64_json, 'aGVsbG8=');
      await flushAsyncWork();
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.model, 'gpt-image-2');
  assertEquals(forwarded.prompt, 'a shiba in space');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.some(row => row.model === 'gpt-image-2' && tokenCountsFromUsage(row).input === 10 && tokenCountsFromUsage(row).output === 50), true);
});

test('/v1/images/edits forwards a multipart request through an Azure model and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, {
    id: 'az-image',
    kind: 'azure',
    name: 'azure-images',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 1,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      models: [{
        upstreamModelId: 'gpt-image-2',
        endpoints: { openaiImagesEdits: {} },
      }],
    },
    state: null,
  });

  let observedForm: FormData | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'example.openai.azure.com') {
        observedForm = await request.formData();
        return jsonResponse({ data: [{ b64_json: 'aGk=' }], usage: { input_tokens: 7, output_tokens: 11 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', 'replace sky with aurora');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const response = await requestAppWithWarmModels('/v1/images/edits', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: form,
      });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: { b64_json: string }[] };
      assertEquals(body.data[0].b64_json, 'aGk=');
      await flushAsyncWork();
    },
  );
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  const image = observedForm?.get('image');
  expect(image).toBeInstanceOf(File);
  if (!(image instanceof File)) throw new TypeError('Expected the upstream multipart image file');
  expect(image.name).toBe('photo.png');
  expect(image.type).toBe('image/png');
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.some(row => row.model === 'gpt-image-2' && tokenCountsFromUsage(row).input === 7 && tokenCountsFromUsage(row).output === 11), true);
});

test.each([
  {
    name: 'JSON upstream error',
    second: () => Response.json({ error: { message: 'vendor error', extra: { retry: true } } }, { status: 429, headers: { 'x-upstream': 'second' } }),
    status: 429,
    body: { error: { message: 'vendor error', extra: { retry: true } } },
  },
  {
    name: 'plain-text upstream error',
    second: () => new Response('temporarily unavailable', { status: 503, headers: { 'x-upstream': 'second' } }),
    status: 503,
    body: { error: { message: 'temporarily unavailable', type: 'api_error' } },
  },
  {
    name: 'successful alternative',
    second: () => Response.json({ data: [], usage: { input_tokens: 3 } }, { headers: { 'x-upstream': 'second' } }),
    status: 200,
    body: { data: [], usage: { input_tokens: 3 } },
  },
  {
    name: 'damaged successful upstream response',
    second: () => new Response('unreadable image result', { headers: { 'x-upstream': 'second' } }),
    status: 502,
    body: { error: { message: expect.any(String), type: 'api_error' } },
  },
])('/v1/images/generations selects the $name and meters each call', async ({ second, status, body }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const [index, id] of ['first', 'second'].entries()) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
      id,
      sortOrder: index,
      config: {
        baseUrl: `https://${id}.example.com`,
        ingressHeadersRules: [],
        apiKey: 'sk-image',
        endpoints: {},
        modelsFetch: { enabled: false, authStyle: 'bearer' },
        models: [{ upstreamModelId: 'image-model', endpoints: { openaiImagesGenerations: {} } }],
      },
    }));
  }
  const called: string[] = [];
  await withMockedFetch(async request => {
    const url = new URL(request.url);
    expect(url.pathname).toBe('/v1/images/generations');
    expect(await request.json()).toEqual({ model: 'image-model', prompt: 'a night sky' });
    called.push(url.hostname);
    return url.hostname === 'first.example.com' ? jsonResponse({ error: { message: 'first error' } }, 500) : second();
  }, async () => {
    const response = await requestAppWithWarmModels('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'image-model', prompt: 'a night sky' }),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('x-upstream')).toBe('second');
    expect(await response.json()).toEqual(body);
  });
  await flushAsyncWork();

  expect(called).toEqual(['first.example.com', 'second.example.com']);
  expect(await repo.performance.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'first', operation: 'image_generation', requests: 1, errorsNoOutput: 1 }),
    expect.objectContaining({ upstream: 'second', operation: 'image_generation', requests: 1, errorsNoOutput: status === 200 ? 0 : 1 }),
  ]));
  expect(await repo.usage.listAll()).toMatchObject(status === 200 ? [{
    upstream: 'second', requests: 1, metrics: [{ metric: 'input_tokens', quantity: '3' }],
  }] : []);
});
