import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

const customConfig = {
  baseUrl: 'https://custom.example.com',
  authStyle: 'bearer',
  apiKey: 'sk-test',
  endpoints: { chatCompletions: {} },
};

const azureConfig = {
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'az-secret',
  models: [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-public',
      endpoints: { chatCompletions: {}, responses: {} },
    },
  ],
};

const copilotConfig = {
  githubToken: 'ghu_secret',
  user: {
    id: 12345,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/octo.png',
  },
};

const createBody = (overrides: Record<string, unknown> = {}) => ({
  provider: 'custom',
  name: 'Test custom upstream',
  config: customConfig,
  flag_overrides: {},
  ...overrides,
});

const authed = (adminSession: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('POST /api/upstreams creates custom upstreams and redacts bearer tokens', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({ flag_overrides: { 'vendor-kimi': true } })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.provider, 'custom');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.baseUrl, 'https://custom.example.com');
  assertEquals(created.flag_overrides, { 'vendor-kimi': true });

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).apiKey, 'sk-test');

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  const items = (await list.json()) as JsonObject[];
  assertEquals(items[0].config.apiKey, undefined);
});

// Regression: the Zod modelEndpointsSchema previously did not list
// `completions`, so a POST that declared a model with only the completions
// capability had it silently stripped by Zod and then failed the runtime
// "must declare at least one endpoint" check.
test('POST /api/upstreams accepts a custom model whose only endpoint is /completions', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'none',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'davinci-002', endpoints: { completions: {} } }],
    },
  })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.config.models[0].endpoints, { completions: {} });
});

test('POST /api/upstreams validates Azure models and redacts API keys', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const invalid = await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'azure', config: { ...azureConfig, models: [] } })));
  assertEquals(invalid.status, 400);
  const invalidBody = (await invalid.json()) as { error?: string };
  assertEquals(invalidBody.error?.includes('models must be a non-empty array'), true);

  const createdResp = await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'azure', name: 'Azure', config: azureConfig })));
  assertEquals(createdResp.status, 201);
  const created = (await createdResp.json()) as JsonObject;
  assertEquals(created.provider, 'azure');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.endpoint, 'https://example.openai.azure.com');
  assertEquals(created.config.models[0].upstreamModelId, 'gpt-prod');
});

test('POST /api/upstreams creates Copilot upstream rows with redacted GitHub tokens', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stub every outbound request: the post-save warm tries to mint a Copilot
  // token + fetch the model catalog, neither of which the test cares about.
  // 403 is the terminal status the Copilot auth retry loop short-circuits on,
  // so the warm fails fast instead of burning ~7s of exponential backoff.
  const created = await withMockedFetch(
    () => jsonResponse({ error: 'forbidden' }, 403),
    async () => {
      const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'copilot', name: 'Copilot', config: copilotConfig })));
      assertEquals(resp.status, 201);
      const body = (await resp.json()) as JsonObject;
      return body;
    },
  );
  assertEquals(created.provider, 'copilot');
  assertEquals(created.config.githubToken, undefined);
  assertEquals(created.config.githubTokenSet, true);
  assertEquals(created.config.user.id, 12345);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).githubToken, 'ghu_secret');
});

test('PATCH /api/upstreams rejects provider changes and preserves the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({ provider: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals(((await patch.json()) as { error?: string }).error, 'provider cannot be changed');
  assertEquals((await repo.upstreams.getById(created.id))?.provider, 'custom');
});

test('PATCH /api/upstreams preserves omitted secrets and re-warms the models cache', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;
  // Plant a stale row so the post-PATCH read can verify the warm overwrote
  // it with the new upstream-supplied catalog rather than leaving the old
  // models in place.
  await repo.modelsCache.put(created.id, {
    fetchedAt: 1,
    models: [{ id: 'stale-model', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'fresh-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ config: { endpoints: { responses: {} } } }),
      });
      assertEquals(patch.status, 200);
    },
  );

  const updated = await repo.upstreams.getById(created.id);
  assertEquals((updated?.config as Record<string, unknown>).apiKey, 'sk-test');
  assertEquals((updated?.config as Record<string, unknown>).endpoints, { responses: {} });

  const cached = await repo.modelsCache.get(created.id);
  assertEquals(cached?.models.map(m => m.id), ['fresh-model']);
  assertEquals(cached!.fetchedAt > 1, true);
});

test('PATCH /api/upstreams keeps Azure as a single endpoint config', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_azure_single_endpoint',
    provider: 'azure',
    name: 'Azure Single Endpoint',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { messages: {} } }],
    },
    state: null,
  });

  const patch = await requestApp('/api/upstreams/up_azure_single_endpoint', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({
      config: {
        models: [{ upstreamModelId: 'gpt-prod', endpoints: { responses: {} } }],
      },
    }),
  });

  assertEquals(patch.status, 200);
  const stored = await repo.upstreams.getById('up_azure_single_endpoint');
  assertEquals(stored?.config, {
    endpoint: 'https://example.openai.azure.com/openai/v1',
    apiKey: 'az-secret',
    models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { responses: {} } }],
  });
});

test('GET /api/upstreams attaches models-cache freshness to every row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Three upstreams cover the three cache states: no row, warm row, warm row
  // with a follow-up failure annotated via setLastError.
  const baseRow = {
    provider: 'custom' as const,
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { baseUrl: 'https://a.example.com', authStyle: 'bearer', apiKey: 'x', endpoints: { chatCompletions: {} } },
    state: null,
  };
  await repo.upstreams.save({ ...baseRow, id: 'up_fresh', name: 'Fresh', sortOrder: 0 });
  await repo.upstreams.save({ ...baseRow, id: 'up_warm', name: 'Warm', sortOrder: 1 });
  await repo.upstreams.save({ ...baseRow, id: 'up_failed', name: 'Failed', sortOrder: 2 });

  await repo.modelsCache.put('up_warm', {
    fetchedAt: 1_700_000_000_000,
    models: [{ id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  await repo.modelsCache.put('up_failed', {
    fetchedAt: 1_700_000_000_000,
    models: [{ id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  await repo.modelsCache.setLastError('up_failed', { message: 'boom', at: 1_700_000_500_000 });

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const items = (await list.json()) as JsonObject[];
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  assertEquals(byId.up_fresh.modelsCache, { fetchedAt: null, lastError: null });
  assertEquals(byId.up_warm.modelsCache, { fetchedAt: 1_700_000_000_000, lastError: null });
  assertEquals(byId.up_failed.modelsCache, {
    fetchedAt: 1_700_000_000_000,
    lastError: { message: 'boom', at: 1_700_000_500_000 },
  });
});

test('GET /api/upstream-flags returns the flag catalog and requires admin auth', async () => {
  const { adminSession, apiKey } = await setupAppTest();

  const resp = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const catalog = (await resp.json()) as Array<Record<string, unknown>>;
  const sample = catalog.find(e => e.id === 'vendor-kimi');
  assertEquals(typeof sample?.label, 'string');
  assertEquals(Array.isArray(sample!.defaultFor), true);
  // appliesTo is not part of the catalog shape; guard against silent re-introduction.
  assertEquals('appliesTo' in sample!, false);

  const forbidden = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-api-key': apiKey.key } });
  assertEquals(forbidden.status, 403);
});

test('GET /api/upstream-options returns the minimal picker shape to admin and non-admin callers', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.upstreams.save({
    id: 'up_disabled_custom',
    provider: 'custom',
    name: 'Disabled Custom',
    enabled: false,
    sortOrder: 5,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { baseUrl: 'https://custom.example.com', authStyle: 'bearer', apiKey: 'sk-secret', endpoints: { chatCompletions: {} } },
    state: null,
  });

  const expected = [
    { id: 'up_copilot', name: 'GitHub Copilot (tester)', provider: 'copilot', enabled: true },
    { id: 'up_disabled_custom', name: 'Disabled Custom', provider: 'custom', enabled: false },
  ];

  const adminResp = await requestApp('/api/upstream-options', { headers: { 'x-floway-session': adminSession } });
  assertEquals(adminResp.status, 200);
  assertEquals(await adminResp.json(), expected);

  const userResp = await requestApp('/api/upstream-options', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(userResp.status, 200);
  const userBody = await userResp.json() as Array<Record<string, unknown>>;
  assertEquals(userBody, expected);
  // No secret-bearing or operator-only fields leak through this endpoint.
  for (const row of userBody) {
    assertEquals(Object.keys(row).sort(), ['enabled', 'id', 'name', 'provider']);
  }
});

test('POST /api/upstreams/fetch-models fetches a draft custom upstream model list', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        assertEquals(request.headers.get('authorization'), 'Bearer sk-test');
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-a' }, { id: 'gpt-b', display_name: 'GPT B' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { provider: 'custom', config: customConfig }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['gpt-a', 'gpt-b']);
      assertEquals(body.data[1].display_name, 'GPT B');
    },
  );
});

test('POST /api/upstreams/fetch-models rejects calls that supply a saved upstream id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_stored_secret',
    provider: 'custom',
    name: 'Stored Secret Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { ...customConfig, apiKey: 'sk-stored-secret' },
    state: null,
  });

  // Saved upstreams must go through GET /api/upstreams/:id/models?refresh=true
  // (the SWR-cached path); fetch-models stays draft-only.
  const resp = await requestApp(
    '/api/upstreams/fetch-models',
    authed(adminSession, { provider: 'custom', id: 'up_stored_secret', config: { ...customConfig, apiKey: '' } }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { message: string; type: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.message.includes('refresh=true'), true);
});

test('POST /api/upstreams/fetch-models projects an ollama draft into UpstreamModelConfig rows with capability-derived endpoints', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'ollama.com' && url.pathname === '/api/tags') {
        return jsonResponse({ models: [{ name: 'gpt-oss:120b' }, { name: 'nomic-embed-text:latest' }] });
      }
      if (url.hostname === 'ollama.com' && url.pathname === '/api/show') {
        const body = await request.json() as { name?: string };
        if (body.name === 'gpt-oss:120b') {
          return jsonResponse({
            capabilities: ['completion', 'tools', 'thinking'],
            details: { family: 'gptoss' },
            model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 },
          });
        }
        if (body.name === 'nomic-embed-text:latest') {
          return jsonResponse({
            capabilities: ['embedding'],
            details: { family: 'nomic-bert' },
            model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 8192 },
          });
        }
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, {
        provider: 'ollama',
        config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      const ids = body.data.map(m => m.upstreamModelId).sort();
      assertEquals(ids, ['gpt-oss:120b', 'nomic-embed-text:latest']);
      const gptoss = body.data.find(m => m.upstreamModelId === 'gpt-oss:120b')!;
      assertEquals(gptoss.kind, 'chat');
      assertEquals(Object.keys(gptoss.endpoints as Record<string, unknown>).sort(), ['chatCompletions', 'completions', 'messages', 'responses']);
      const embed = body.data.find(m => m.upstreamModelId === 'nomic-embed-text:latest')!;
      assertEquals(embed.kind, 'embedding');
      assertEquals(Object.keys(embed.endpoints as Record<string, unknown>), ['embeddings']);
    },
  );
});

test('POST /api/upstreams/fetch-models surfaces upstream model-listing failures as 502', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { provider: 'custom', config: customConfig }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: { message: string; type: string } };
      assertEquals(body.error.type, 'api_error');
    },
  );
});

test('POST /api/upstreams/fetch-models surfaces an ollama /api/tags failure as 502', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'ollama.com' && url.pathname === '/api/tags') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, {
        provider: 'ollama',
        config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
      }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: { message: string; type: string } };
      assertEquals(body.error.type, 'api_error');
    },
  );
});

test('POST /api/upstreams/fetch-models rejects a malformed draft config with 400', async () => {
  const { adminSession } = await setupAppTest();

  // Blank token with no id and no stored secret to substitute: the runtime
  // assert rejects the empty apiKey, surfaced as a 400 validation error.
  const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { provider: 'custom', config: { ...customConfig, apiKey: '' } }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('apiKey'), true);
});

test('GET /api/upstreams/:id/models?refresh=true forces a fresh upstream fetch', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_refresh',
    provider: 'custom',
    name: 'Refresh Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { ...customConfig, apiKey: 'sk-refresh' },
    state: null,
  });
  // SOFT-fresh row: without ?refresh=true the cache returns it verbatim.
  await repo.modelsCache.put('up_refresh', {
    fetchedAt: Date.now(),
    models: [{ id: 'cached-model', kind: 'chat', endpoints: { chatCompletions: {} }, enabledFlags: new Set(), limits: {} }],
  });

  let upstreamCalls = 0;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        upstreamCalls += 1;
        return jsonResponse({ object: 'list', data: [{ id: 'fresh-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const cached = await requestApp('/api/upstreams/up_refresh/models', { headers: { 'x-floway-session': adminSession } });
      assertEquals(cached.status, 200);
      const cachedBody = (await cached.json()) as { data: Array<{ upstreamModelId: string }> };
      assertEquals(cachedBody.data.map(m => m.upstreamModelId), ['cached-model']);
      assertEquals(upstreamCalls, 0);

      const refreshed = await requestApp('/api/upstreams/up_refresh/models?refresh=true', { headers: { 'x-floway-session': adminSession } });
      assertEquals(refreshed.status, 200);
      const refreshedBody = (await refreshed.json()) as { data: Array<{ upstreamModelId: string }> };
      assertEquals(refreshedBody.data.map(m => m.upstreamModelId), ['fresh-model']);
      assertEquals(upstreamCalls, 1);
    },
  );

  const stored = await repo.modelsCache.get('up_refresh');
  assertEquals(stored?.models.map(m => m.id), ['fresh-model']);
});

test('GET /api/upstreams/:id/models resolves a saved upstream catalog and 404s for an unknown id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'azure', name: 'Az', config: azureConfig })))).json()) as { id: string };

  const resp = await requestApp(`/api/upstreams/${created.id}/models`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { data: Array<{ upstreamModelId: string; publicModelId: string; kind: string; endpoints: Record<string, unknown> }> };
  // Azure config carries `upstreamModelId: 'gpt-prod', publicModelId: 'gpt-public'`,
  // so the GET response round-trips both ids: the operator's wire-side
  // deployment id under `upstreamModelId`, and the public alias (the catalog
  // `model.id`) under `publicModelId`.
  assertEquals(body.data[0].upstreamModelId, 'gpt-prod');
  assertEquals(body.data[0].publicModelId, 'gpt-public');
  assertEquals(body.data[0].kind, 'chat');

  const missing = await requestApp('/api/upstreams/nope/models', { headers: { 'x-floway-session': adminSession } });
  assertEquals(missing.status, 404);
});

test('POST /api/upstreams warms the models cache before responding', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'warmed-on-create' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams', authed(adminSession, createBody()));
      assertEquals(resp.status, 201);
      return (await resp.json()) as { id: string };
    },
  );

  const cached = await repo.modelsCache.get(created.id);
  assertEquals(cached?.models.map(m => m.id), ['warmed-on-create']);
});

test('PATCH /api/upstreams warms the models cache before responding', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string };
  // Drop whatever the create-time warm landed on disk so the PATCH-time warm
  // is the only writer in this test's window.
  await repo.modelsCache.delete(created.id);

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'warmed-on-update' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      assertEquals(patch.status, 200);
    },
  );

  const cached = await repo.modelsCache.get(created.id);
  assertEquals(cached?.models.map(m => m.id), ['warmed-on-update']);
});

test('POST /api/upstreams/fetch-models without an id still serves draft preview', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'draft-only' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { provider: 'custom', config: customConfig }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['draft-only']);
    },
  );
});

// --- Codex routes ---
//
// The auth.json import path lets us drive the OAuth ingestion deterministically
// without mocking the token-exchange roundtrip: parseCodexIdTokenClaims decodes
// the id_token JWT directly. Build a fake JWT that carries the identity claims
// the production parser requires.
const encodeBase64Url = (input: string): string =>
  btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fakeIdToken = (claims: Record<string, unknown>): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_test',
      chatgpt_user_id: 'usr_test',
      chatgpt_plan_type: 'plus',
    },
    'https://api.openai.com/profile': { email: 'alice@example.com' },
    ...claims,
  }));
  return `${header}.${payload}.fake-signature`;
};

const codexAuthJsonImport = (overrides: Record<string, unknown> = {}) => ({
  name: 'ChatGPT Codex',
  auth_json: JSON.stringify({
    tokens: {
      access_token: 'at_test',
      refresh_token: 'rt_test',
      id_token: fakeIdToken({}),
    },
    ...overrides,
  }),
});

test('POST /api/upstreams/codex-authorize-url stamps SPA-provided challenge + state into the auth.openai.com URL', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/codex-authorize-url',
    authed(adminSession, { challenge: 'TEST_CHALLENGE', state: 'TEST_STATE' }),
  );
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string };
  const url = new URL(body.authorize_url);
  assertEquals(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assertEquals(url.searchParams.get('code_challenge'), 'TEST_CHALLENGE');
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(url.searchParams.get('state'), 'TEST_STATE');
});

test('POST /api/upstreams/codex-import (callback) exchanges the SPA-supplied verifier for tokens and persists the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_cb', refresh_token: 'rt_cb', id_token: fakeIdToken({}), expires_in: 600 }),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/codex-import',
        authed(adminSession, { name: 'ChatGPT Codex', callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER' } }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { provider: string; state: { accounts: Array<{ refresh_token_set: boolean }> } };
      assertEquals(created.provider, 'codex');
      assertEquals(created.state.accounts[0].refresh_token_set, true);
    },
  );
});

test('POST /api/upstreams/codex-import (auth_json) creates a codex upstream with state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.provider, 'codex');
  assertEquals(created.config.accounts[0].email, 'alice@example.com');
  assertEquals(created.config.accounts[0].chatgptAccountId, 'acc_test');
  assertEquals(created.config.accounts[0].planType, 'plus');
  assertEquals(created.state.accounts[0].state, 'active');
  assertEquals(created.state.accounts[0].refresh_token_set, true);

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_test');
});

test('POST /api/upstreams/codex-import without an explicit name auto-derives one from the imported identity', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, { auth_json: codexAuthJsonImport().auth_json }));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as { name: string };
  assertEquals(created.name, 'ChatGPT Codex (alice@example.com)');
});

test('POST /api/upstreams/codex-import rejects when both auth_json and callback are absent', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, { name: 'ChatGPT Codex' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { issues?: Array<{ message: string }> } | string };
  // The schema-level XOR refine surfaces as a zod validation error envelope.
  assertEquals(JSON.stringify(body).includes('Provide exactly one of auth_json or callback'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now rejects non-codex rows with 404', async () => {
  const { adminSession } = await setupAppTest();

  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json()) as { id: string };
  const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/:id/codex-refresh-now rejects upstreams in a terminal state with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Plant a codex upstream in `session_terminated` state by importing then
  // hand-mutating the row (the routes never expose a way to get into this
  // state without a real upstream 401).
  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: { accounts: storedState.accounts.map(a => ({ ...a, state: 'session_terminated' })) },
  });

  const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('session_terminated'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now rotates the refresh token on success', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  await withMockedFetch(
    () => jsonResponse({
      access_token: 'at_rotated',
      refresh_token: 'rt_rotated',
      id_token: fakeIdToken({}),
      expires_in: 3600,
    }),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_rotated');
});

test('POST /api/upstreams/:id/codex-refresh-now flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
      // 400, not 502: the upstream answered — it's the stored credential
      // that's dead. Not 401 either, since the dashboard's auth client
      // treats any 401 as a logout signal.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.includes('Re-import'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; state_message?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].state_message, 'string');
});

test('POST /api/upstreams/:id/codex-refresh-now still answers when the failure-state CAS write loses to a concurrent mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  // Race: another writer rotates the refresh_token between our read and our
  // failure-state CAS write. The route should still respond — the concurrent
  // writer's state is fresher than our `refresh_failed` proposal by
  // construction, so we drop ours rather than overwrite theirs.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };

  await withMockedFetch(
    async () => {
      // Simulate the concurrent writer mid-OAuth by mutating the row before
      // the route reaches its CAS write. The OAuth call itself fails terminally.
      await repo.upstreams.save({
        ...stored!,
        state: { accounts: storedState.accounts.map(a => ({ ...a, refresh_token: 'rt_concurrent_winner' })) },
      });
      return new Response(
        JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 400);
    },
  );

  // The concurrent writer's state survives — our refresh_failed write was
  // dropped by the CAS guard, which is the intended best-effort behavior.
  const after = await repo.upstreams.getById(created.id);
  const afterState = after?.state as { accounts: Array<{ state: string; refresh_token: string }> };
  assertEquals(afterState.accounts[0].refresh_token, 'rt_concurrent_winner');
  assertEquals(afterState.accounts[0].state, 'active');
});

// --- Claude Code routes ---
//
// Test setup mirrors the codex routes: we drive the OAuth + profile fetches
// through withMockedFetch so the import handler runs end-to-end without
// hitting the real upstream.

const claudeCodeProfileBody = {
  account: { uuid: 'acc-uuid-1', email: 'alice@example.com' },
  organization: { uuid: 'org-uuid-1', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
};

const claudeCodeTokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'at_test',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt_test',
  scope: 'user:inference',
  ...overrides,
});

const claudeCodeCredentialsJson = (overrides: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {}) => JSON.stringify({
  claudeAiOauth: {
    accessToken: overrides.accessToken ?? 'cli_at',
    refreshToken: overrides.refreshToken ?? 'cli_rt',
    expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
});

test('POST /api/upstreams/claude-code-authorize-url stamps SPA-provided challenge + state into the OAuth URL', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code-authorize-url',
    authed(adminSession, { challenge: 'TEST_CHALLENGE', state: 'TEST_STATE', kind: 'oauth' }),
  );
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string };
  const url = new URL(body.authorize_url);
  assertEquals(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assertEquals(url.searchParams.get('code_challenge'), 'TEST_CHALLENGE');
  assertEquals(url.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(url.searchParams.get('state'), 'TEST_STATE');
});

test('POST /api/upstreams/claude-code-import (callback) exchanges the SPA-supplied verifier and persists a row with access token + refresh-token-set flag', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeTokenBody());
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return jsonResponse(claudeCodeProfileBody);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { name: 'Claude Code', callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER', state: 'TEST_STATE' } }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { provider: string; state: { accounts: Array<{ refreshTokenSet: boolean; accessToken: { expiresAt: number } | null }> } };
      assertEquals(created.provider, 'claude-code');
      assertEquals(created.state.accounts[0].refreshTokenSet, true);
      assertEquals(typeof created.state.accounts[0].accessToken?.expiresAt, 'number');
    },
  );
});

test('POST /api/upstreams/claude-code-import (credentials_json) creates a row with the cached access token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as JsonObject;
      assertEquals(created.provider, 'claude-code');
      assertEquals(created.config.accounts[0].email, 'alice@example.com');
      assertEquals(created.config.accounts[0].accountUuid, 'acc-uuid-1');
      // CLI subscriptionType + rateLimitTier verbatim from the persisted
      // credentials.json win over what the live profile endpoint would
      // derive (which would also be 'max' in this fixture, but the
      // assertion proves the persisted-wins path).
      assertEquals(created.config.accounts[0].subscriptionType, 'max');
      assertEquals((created.config.accounts[0] as { rateLimitTier: string | null }).rateLimitTier, 'default_claude_max_20x');
      assertEquals(created.state.accounts[0].state, 'active');
      assertEquals(created.state.accounts[0].refreshTokenSet, true);
    },
  );
});

test('POST /api/upstreams/claude-code-import without an explicit name auto-derives one from the imported email', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { name: string };
      assertEquals(created.name, 'Claude Code (alice@example.com)');
    },
  );
});

test('POST /api/upstreams/claude-code-import rejects when both credentials_json and callback are absent', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/claude-code-import', authed(adminSession, { name: 'Claude Code' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as unknown;
  assertEquals(JSON.stringify(body).includes('Provide exactly one of credentials_json or callback'), true);
});

test('POST /api/upstreams/claude-code-import rejects a callback missing the verifier', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code-import',
    authed(adminSession, { name: 'Claude Code', callback: { code: 'AUTH_CODE' } }),
  );
  assertEquals(resp.status, 400);
});

test('PATCH /api/upstreams rejects config edits on a claude-code row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { accounts: [] } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.includes('claude-code-reimport'), true);
});

test('PATCH /api/upstreams accepts metadata edits on a claude-code row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: 'My Claude Max', enabled: false }),
  });
  assertEquals(patch.status, 200);
  const body = (await patch.json()) as { name: string; enabled: boolean };
  assertEquals(body.name, 'My Claude Max');
  assertEquals(body.enabled, false);
});

test('POST /api/upstreams rejects a direct claude-code create with a redirect message', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams', authed(adminSession, {
    provider: 'claude-code',
    name: 'Claude Code',
    config: {},
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('claude-code-import'), true);
});

test('POST /api/upstreams/:id/claude-code-refresh-now rejects non-claude-code rows with 404', async () => {
  const { adminSession } = await setupAppTest();

  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json()) as { id: string };
  const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/:id/claude-code-refresh-now rejects upstreams in a terminal state with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Plant a row in `refresh_failed` by importing then hand-mutating the row.
  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: {
      accounts: storedState.accounts.map(a => ({
        ...a,
        state: 'refresh_failed',
        stateMessage: 'token revoked',
        accessToken: null,
      })),
    },
  });

  const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('refresh_failed'), true);
});

test('POST /api/upstreams/:id/claude-code-refresh-now rotates the refresh token on success', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    () => jsonResponse(claudeCodeTokenBody({ access_token: 'at_rotated', refresh_token: 'rt_rotated' })),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refreshToken: string }> };
  assertEquals(storedState.accounts[0].refreshToken, 'rt_rotated');
});

test('POST /api/upstreams/:id/claude-code-refresh-now flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token revoked' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      // 400, not 502: same reasoning as codex — the upstream answered,
      // it's the stored credential that's dead. Not 401 either, to avoid
      // logging the operator out of the dashboard.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.includes('Re-import'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; stateMessage?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].stateMessage, 'string');
});

// Refresh-race recovery (audit axis #10): when our refresh-now mint loses
// the rotation race to a sibling — typically a data-plane request that
// hit `/v1/oauth/token` a moment earlier and already wrote the rotated
// state — the operator should NOT see a misleading "credential dead"
// toast. The data-plane analog is `recoverFromRefreshRace` in
// access-token-cache.ts (commit f1efc9dd); these tests pin the
// control-plane mirror.

test('POST /api/upstreams/:id/claude-code-refresh-now recovers as success when a sibling already rotated mid-flight', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  // Race simulation: when our route POSTs /v1/oauth/token, a sibling has
  // already rotated the RT and written a fresh access token. The upstream
  // sees our (now stale) RT and answers `invalid_grant`. The route should
  // re-read state, observe the sibling's rotation, and surface success.
  const siblingExpiresAt = Date.now() + 3_600_000;
  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        // Plant the sibling's rotation result before answering with invalid_grant.
        const row = await repo.upstreams.getById(created.id);
        const rowState = row!.state as { accounts: Array<Record<string, unknown>> };
        await repo.upstreams.save({
          ...row!,
          state: {
            accounts: rowState.accounts.map(a => ({
              ...a,
              refreshToken: 'rt_sibling_rotated',
              accessToken: {
                token: 'at_sibling_rotated',
                expiresAt: siblingExpiresAt,
                refreshedAt: new Date().toISOString(),
              },
            })),
          },
        });
        return new Response(
          JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token already used' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { state: { accounts: Array<{ state: string; accessToken: { expiresAt: number } | null }> } };
      // The surfaced state mirrors the sibling's rotation — still active,
      // access token timestamps match what the sibling wrote.
      assertEquals(body.state.accounts[0].state, 'active');
      assertEquals(body.state.accounts[0].accessToken?.expiresAt, siblingExpiresAt);
    },
  );

  // Underlying row is the sibling's rotation — we did not clobber it with
  // a refresh_failed flip or an attempt to re-write the same state.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; refreshToken: string; accessToken: { token: string } | null }> };
  assertEquals(storedState.accounts[0].state, 'active');
  assertEquals(storedState.accounts[0].refreshToken, 'rt_sibling_rotated');
  assertEquals(storedState.accounts[0].accessToken?.token, 'at_sibling_rotated');
});

test('POST /api/upstreams/:id/claude-code-refresh-now still flips terminal when invalid_grant is genuine (RT unchanged)', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  // No sibling rotation: the upstream rejects our RT and the row still
  // carries the same RT on re-read. Recovery must conclude "genuine
  // failure" and fall through to the terminal-flip path.
  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token revoked' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 400);
      const body = (await resp.json()) as { error: string };
      assertEquals(body.error.includes('Re-import'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; stateMessage?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].stateMessage, 'string');
});

// --- proxy_fallback_list ---
//
// The list has set semantics — duplicates are dropped silently before
// storage. Order is meaningful at dial time. Both POST and PATCH normalize
// the list so the wire response matches what GET returns afterwards.

test('POST /api/upstreams accepts proxy_fallback_list and surfaces it in the response', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct' }] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct' }]);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'p_fallback' }, { id: 'direct' }]);
});

test('POST /api/upstreams normalises proxy_fallback_list duplicates so the response matches what GET returns', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct' }, { id: 'p_fallback' }, { id: 'direct' }] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  // Without the API-layer normalize, the response would echo the duplicates
  // while the saved row only kept one of each — operators would see a
  // different list on POST vs the next GET.
  assertEquals(created.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct' }]);

  const get = await requestApp('/api/upstreams', authed(adminSession));
  const list = (await get.json()) as JsonObject[];
  const fresh = list.find(u => u.id === created.id);
  assertEquals(fresh!.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct' }]);
});

test('PATCH /api/upstreams sets proxy_fallback_list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string; proxy_fallback_list: { id: string; colos?: string[] }[] };
  assertEquals(created.proxy_fallback_list, []);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct' }] }),
  });
  assertEquals(patch.status, 200);
  const updated = (await patch.json()) as JsonObject;
  assertEquals(updated.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct' }]);
});

test('PATCH /api/upstreams rejects proxy_fallback_list referencing an unknown proxy id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string };

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'nope' }] }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('DELETE /api/upstreams sweeps orphaned proxy backoff rows', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_a' }] })));
  const created = (await create.json()) as { id: string };

  await repo.proxyBackoffs.recordDialFailure('p_a', created.id, 'tcp refused');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'other_upstream', 'tcp refused');
  assertEquals((await repo.proxyBackoffs.listAll()).length, 2);

  const del = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(del.status, 200);

  const remaining = await repo.proxyBackoffs.listAll();
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0]!.upstreamId, 'other_upstream');
});

// --- pre-save proxy_fallback_list override ---

test('POST /api/upstreams/:id/claude-code-refresh-now honors the proxy_fallback_list override over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stash a real proxy id so the persisted list has a non-direct entry; the
  // override below points at a different (unknown) id, so a 400 from the
  // route proves the override won — not the persisted row.
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  // Persist a non-direct fallback list so a successful default-path refresh
  // would route through `p_real`. The override below should win.
  await repo.upstreams.save({ ...(await repo.upstreams.getById(created.id))!, proxyFallbackList: [{ id: 'p_real' }] });

  const resp = await requestApp(
    `/api/upstreams/${created.id}/claude-code-refresh-now`,
    authed(adminSession, { proxy_fallback_list: [{ id: 'p_unknown' }] }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now honors the proxy_fallback_list override over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  const resp = await requestApp(
    `/api/upstreams/${created.id}/codex-refresh-now`,
    authed(adminSession, { proxy_fallback_list: [{ id: 'p_unknown' }] }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/:id/claude-code-refresh-now without an override falls back to the persisted list (no override → no validation failure)', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  // Empty body → no override → persisted ([]) → direct egress → mocked fetch
  // serves the refresh response. A successful 200 proves the "no override"
  // path did not validate against the proxies table (it skipped validation
  // because no override was sent).
  await withMockedFetch(
    () => jsonResponse(claudeCodeTokenBody({ access_token: 'at_rotated', refresh_token: 'rt_rotated' })),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );
});

test('POST /api/upstreams/copilot/auth/poll honors the proxy_fallback_list override', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp(
    '/api/upstreams/copilot/auth/poll',
    authed(adminSession, { device_code: 'dev', proxy_fallback_list: [{ id: 'p_unknown' }] }),
  );
  // resolveControlPlaneFetcher throws synchronously when validating the
  // override; the handler's outer catch maps that to a 502 with the
  // error message intact.
  assertEquals(resp.status, 502);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

// --- import / reimport proxy_fallback_list override ---
//
// Import and re-import fire before (or alongside) a save, so the operator's
// in-flight proxy edit must accompany the request. Two behaviors:
//   1. The bootstrap call (OAuth token exchange + identity fetch) routes
//      through the override.
//   2. The override is persisted on the new (import) / existing (re-import)
//      row so subsequent data-plane calls use the same chain without a
//      follow-up edit.

test('POST /api/upstreams/claude-code-import rejects an override referencing an unknown proxy id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp(
    '/api/upstreams/claude-code-import',
    authed(adminSession, {
      credentials_json: claudeCodeCredentialsJson(),
      proxy_fallback_list: [{ id: 'p_unknown' }],
    }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/claude-code-import persists the override on the new row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  // Real proxy id so the override validates; 'direct' alone short-circuits
  // override resolution to directFetcher, so we use a real proxy + 'direct'
  // to exercise persistence without the bootstrap actually dialing through
  // a non-existent socks5 endpoint. The credentials_json path only fetches
  // /api/oauth/profile, which we let the mock serve directly.
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, {
          credentials_json: claudeCodeCredentialsJson(),
          // 'direct' first → the override fetcher short-circuits to direct
          // and the mocked fetch above handles the identity call. 'p_real'
          // tails so persistence shows a non-trivial list.
          proxy_fallback_list: [{ id: 'direct' }, { id: 'p_real' }],
        }),
      );
      assertEquals(r.status, 201);
      return (await r.json()) as { id: string; proxy_fallback_list: { id: string }[] };
    },
  );

  assertEquals(created.proxy_fallback_list, [{ id: 'direct' }, { id: 'p_real' }]);
  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_real' }]);
});

test('POST /api/upstreams/claude-code-import without an override persists an empty list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string; proxy_fallback_list: { id: string }[] };
    },
  );

  assertEquals(created.proxy_fallback_list, []);
});

test('POST /api/upstreams/:id/claude-code-reimport overwrites the persisted proxy_fallback_list when an override is supplied', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_initial', name: 'Initial', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });
  await repo.proxies.insert({ id: 'p_new', name: 'New', url: 'socks5://198.51.100.11:1080', dialTimeoutSeconds: null });

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, {
          credentials_json: claudeCodeCredentialsJson(),
          proxy_fallback_list: [{ id: 'direct' }, { id: 'p_initial' }],
        }),
      );
      return (await r.json()) as { id: string };
    },
  );

  const reimported = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        `/api/upstreams/${created.id}/claude-code-reimport`,
        authed(adminSession, {
          credentials_json: claudeCodeCredentialsJson(),
          proxy_fallback_list: [{ id: 'direct' }, { id: 'p_new' }],
        }),
      );
      assertEquals(r.status, 200);
      return (await r.json()) as { proxy_fallback_list: { id: string }[] };
    },
  );

  assertEquals(reimported.proxy_fallback_list, [{ id: 'direct' }, { id: 'p_new' }]);
  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_new' }]);
});

test('POST /api/upstreams/:id/claude-code-reimport without an override leaves the persisted proxy_fallback_list untouched', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_initial', name: 'Initial', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, {
          credentials_json: claudeCodeCredentialsJson(),
          proxy_fallback_list: [{ id: 'direct' }, { id: 'p_initial' }],
        }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        `/api/upstreams/${created.id}/claude-code-reimport`,
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      assertEquals(r.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_initial' }]);
});

test('POST /api/upstreams/codex-import rejects an override referencing an unknown proxy id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, { ...codexAuthJsonImport(), proxy_fallback_list: [{ id: 'p_unknown' }] }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/codex-import persists the override on the new row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, { ...codexAuthJsonImport(), proxy_fallback_list: [{ id: 'direct' }, { id: 'p_real' }] }),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as { id: string; proxy_fallback_list: { id: string }[] };
  assertEquals(created.proxy_fallback_list, [{ id: 'direct' }, { id: 'p_real' }]);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_real' }]);
});

test('POST /api/upstreams/codex-import without an override persists an empty list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as { id: string; proxy_fallback_list: { id: string }[] };
  assertEquals(created.proxy_fallback_list, []);
});

test('POST /api/upstreams/:id/codex-reimport overwrites the persisted proxy_fallback_list when an override is supplied', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_initial', name: 'Initial', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });
  await repo.proxies.insert({ id: 'p_new', name: 'New', url: 'socks5://198.51.100.11:1080', dialTimeoutSeconds: null });

  const create = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, { ...codexAuthJsonImport(), proxy_fallback_list: [{ id: 'direct' }, { id: 'p_initial' }] }),
  );
  const created = (await create.json()) as { id: string };

  const reimport = await requestApp(
    `/api/upstreams/${created.id}/codex-reimport`,
    authed(adminSession, { ...codexAuthJsonImport(), proxy_fallback_list: [{ id: 'direct' }, { id: 'p_new' }] }),
  );
  assertEquals(reimport.status, 200);
  const reimported = (await reimport.json()) as { proxy_fallback_list: { id: string }[] };
  assertEquals(reimported.proxy_fallback_list, [{ id: 'direct' }, { id: 'p_new' }]);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_new' }]);
});

test('POST /api/upstreams/:id/codex-reimport without an override leaves the persisted proxy_fallback_list untouched', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_initial', name: 'Initial', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, { ...codexAuthJsonImport(), proxy_fallback_list: [{ id: 'direct' }, { id: 'p_initial' }] }),
  );
  const created = (await create.json()) as { id: string };

  const reimport = await requestApp(
    `/api/upstreams/${created.id}/codex-reimport`,
    authed(adminSession, codexAuthJsonImport()),
  );
  assertEquals(reimport.status, 200);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_initial' }]);
});

// --- claude-code Setup-Token routes ---

const claudeCodeSetupTokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'st_long_lived',
  token_type: 'Bearer',
  expires_in: 31536000,
  scope: 'user:inference',
  ...overrides,
});

const claudeCodePermissionError403 = () => jsonResponse(
  { error: { type: 'permission_error', message: 'token lacks user:profile scope' } },
  403,
);

test('POST /api/upstreams/claude-code-authorize-url with kind=setup-token narrows the scope to user:inference', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code-authorize-url',
    authed(adminSession, { challenge: 'TEST_CHALLENGE', state: 'TEST_STATE', kind: 'setup-token' }),
  );
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { authorize_url: string };
  const url = new URL(body.authorize_url);
  assertEquals(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
  assertEquals(url.searchParams.get('scope'), 'user:inference');
});

test('POST /api/upstreams/claude-code-setup-token-import (callback) creates a setup-token credential and persists tokenKind', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        // Verify the exchange body asks for the long-lived bearer.
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        assertEquals(body.expires_in, 31536000);
        return jsonResponse(claudeCodeSetupTokenBody());
      }
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') {
        // Setup-token bearer lacks user:profile; the import path falls back
        // to a degraded identity rather than refusing the import.
        return claudeCodePermissionError403();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-setup-token-import',
        authed(adminSession, { callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER', state: 'TEST_STATE' } }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as {
        id: string; provider: string;
        config: { accounts: Array<{ email: string | null; accountUuid: string }> };
        state: { accounts: Array<{ tokenKind: string; refreshTokenSet: boolean; accessToken: { expiresAt: number } | null }> };
      };
      assertEquals(created.provider, 'claude-code');
      assertEquals(created.state.accounts[0].tokenKind, 'setup-token');
      // No refresh token on the wire view — the serializer surfaces presence
      // as `refreshTokenSet`. For setup-token it's always false.
      assertEquals(created.state.accounts[0].refreshTokenSet, false);
      // Degraded identity: deterministic UUID + null email.
      assertEquals(created.config.accounts[0].email, null);
      // Long-lived expiry — at least 360 days out.
      const expiresAt = created.state.accounts[0].accessToken?.expiresAt ?? 0;
      assertEquals(expiresAt > Date.now() + 360 * 24 * 60 * 60 * 1000, true);
    },
  );
});

test('POST /api/upstreams/:id/claude-code-refresh-now rejects setup-token credentials', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  let upstreamId = '';
  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeSetupTokenBody());
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return claudeCodePermissionError403();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-setup-token-import',
        authed(adminSession, { callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER', state: 'TEST_STATE' } }),
      );
      if (resp.status !== 201) {
        const body = await resp.text();
        throw new Error(`Setup-token import failed: ${resp.status} ${body}`);
      }
      const created = (await resp.json()) as { id: string };
      upstreamId = created.id;
    },
  );

  const refresh = await requestApp(
    `/api/upstreams/${upstreamId}/claude-code-refresh-now`,
    authed(adminSession, {}),
  );
  assertEquals(refresh.status, 400);
  const body = (await refresh.json()) as { error: string };
  assertEquals(body.error.includes('Setup-token'), true);
});

test('POST /api/upstreams/:id/claude-code-setup-token-reimport replaces credentials in place', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  let upstreamId = '';
  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeSetupTokenBody({ access_token: 'st_v1' }));
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return claudeCodePermissionError403();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-setup-token-import',
        authed(adminSession, { callback: { code: 'AUTH_CODE_1', verifier: 'VERIFIER_1', state: 'TEST_STATE' } }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { id: string };
      upstreamId = created.id;
    },
  );

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeSetupTokenBody({ access_token: 'st_v2' }));
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return claudeCodePermissionError403();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        `/api/upstreams/${upstreamId}/claude-code-setup-token-reimport`,
        authed(adminSession, { callback: { code: 'AUTH_CODE_2', verifier: 'VERIFIER_2', state: 'TEST_STATE' } }),
      );
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(upstreamId);
  const storedState = stored?.state as { accounts: Array<{ tokenKind: string; accessToken: { token: string } | null }> };
  assertEquals(storedState.accounts[0].tokenKind, 'setup-token');
  assertEquals(storedState.accounts[0].accessToken?.token, 'st_v2');
});

test('POST /api/upstreams/copilot/auth/poll persists the override on the freshly-created row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  // Drive the device-flow poll deterministically: every GitHub-side call
  // the handler makes (oauth token exchange, /user, and the import-time
  // /copilot_internal/v2/token mint that seeds state.copilotToken with the
  // per-tier endpoints.api) must resolve, otherwise the token exchange falls
  // into copilot auth's withRetry backoff and the test stalls for ~7s before
  // passing.
  await withMockedFetch(
    async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
        return jsonResponse({ access_token: 'ghu_test', token_type: 'bearer', scope: 'read:user' });
      }
      if (url.hostname === 'api.github.com' && url.pathname === '/user') {
        return jsonResponse({ login: 'octo', avatar_url: 'https://example.com/a.png', name: 'Octo', id: 99 });
      }
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'ct_test', expires_at: Math.floor(Date.now() / 1000) + 1500, refresh_in: 1200, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      // Models warmup probes the copilot api host; an empty list keeps the
      // warmup quiet without exercising the catalog.
      if (url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/copilot/auth/poll',
        authed(adminSession, {
          device_code: 'dev',
          // 'direct' short-circuits the override fetcher to direct so the
          // mocks above serve the bootstrap; persistence still records the
          // full chain.
          proxy_fallback_list: [{ id: 'direct' }, { id: 'p_real' }],
        }),
      );
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { status: string; upstream: { id: string; proxy_fallback_list: Array<{ id: string }> } };
      assertEquals(body.status, 'complete');
      assertEquals(body.upstream.proxy_fallback_list, [{ id: 'direct' }, { id: 'p_real' }]);
      const stored = await repo.upstreams.getById(body.upstream.id);
      assertEquals(stored?.proxyFallbackList, [{ id: 'direct' }, { id: 'p_real' }]);
    },
  );
});

test('POST /api/upstreams/:id/codex-refresh-now without an override falls back to the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  // No override → persisted ([]) → direct egress → the mocked fetch
  // serves the refresh response. A 200 proves the "no override" path
  // skipped catalog validation entirely.
  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_rotated', refresh_token: 'rt_rotated', id_token: fakeIdToken({}), expires_in: 600 }),
    async () => {
      const resp = await requestApp(
        `/api/upstreams/${created.id}/codex-refresh-now`,
        authed(adminSession, {}),
      );
      assertEquals(resp.status, 200);
    },
  );
});

// --- POST /api/upstreams/:id/claude-code-probe-quota ---
//
// Operator-driven active quota probe — Claude Code only. Mirrors real CC's
// `fetchUtilization: GET /api/oauth/usage` call so operators get the same
// snapshot the CLI sees without burning a model request. Returns the body
// verbatim and persists into usageProbeSnapshot state for the dashboard.

const usageProbeBody = {
  five_hour: { utilization: 0.42, resets_at: '2026-06-19T20:00:00Z' },
  seven_day: { utilization: 0.10, resets_at: '2026-06-25T18:00:00Z' },
  seven_day_sonnet: { utilization: 0.05, resets_at: '2026-06-25T18:00:00Z' },
};

test('POST /api/upstreams/:id/claude-code-probe-quota returns Anthropic body verbatim and persists into state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.anthropic.com/api/oauth/usage') {
        assertEquals(request.headers.get('authorization'), 'Bearer cli_at');
        assertEquals(request.headers.get('anthropic-beta'), 'oauth-2025-04-20');
        return jsonResponse(usageProbeBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-probe-quota`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as Record<string, unknown> & { fetched_at: string };
      assertEquals(typeof body.fetched_at, 'string');
      assertEquals(body.five_hour, usageProbeBody.five_hour);
      assertEquals(body.seven_day, usageProbeBody.seven_day);
      assertEquals(body.seven_day_sonnet, usageProbeBody.seven_day_sonnet);
    },
  );

  // The persisted snapshot is observable via the next GET /api/upstreams.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ usageProbeSnapshot: { fetchedAt: number; data: Record<string, unknown> } | null }> };
  assertEquals(storedState.accounts[0].usageProbeSnapshot?.data, usageProbeBody);
  assertEquals(typeof storedState.accounts[0].usageProbeSnapshot?.fetchedAt, 'number');
});

test('POST /api/upstreams/:id/claude-code-probe-quota mints a fresh access token when the cached one is stale', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Import then expire the cached access token so the route's ensureClaudeCodeAccessToken
  // call falls through to the refresh path. The refresh round-trip + probe
  // call both ride through the mocked fetch.
  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson({ expiresAt: Date.now() - 60_000 }) }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') {
        return jsonResponse(claudeCodeTokenBody({ access_token: 'at_refreshed', refresh_token: 'rt_v2' }));
      }
      if (request.url === 'https://api.anthropic.com/api/oauth/usage') {
        // Probe rides on the freshly-minted access token, not the stale one.
        assertEquals(request.headers.get('authorization'), 'Bearer at_refreshed');
        return jsonResponse(usageProbeBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-probe-quota`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );
});

test('POST /api/upstreams/:id/claude-code-probe-quota surfaces upstream 401 as 502', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-probe-quota`, authed(adminSession, {}));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: string };
      assertEquals(body.error.includes('401'), true);
    },
  );
});

test('POST /api/upstreams/:id/claude-code-probe-quota rejects non-claude-code upstreams with 400', async () => {
  const { adminSession } = await setupAppTest();
  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json()) as { id: string };

  const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-probe-quota`, authed(adminSession, {}));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('claude-code'), true);
});

test('POST /api/upstreams/:id/claude-code-probe-quota 404s for an unknown upstream id', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams/nope/claude-code-probe-quota', authed(adminSession, {}));
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/codex-import honors the proxy_fallback_list override over the persisted list', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, {
      callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER' },
      proxy_fallback_list: [{ id: 'p_unknown' }],
    }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/:id/codex-reimport honors the proxy_fallback_list override over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  const resp = await requestApp(
    `/api/upstreams/${created.id}/codex-reimport`,
    authed(adminSession, {
      callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER' },
      proxy_fallback_list: [{ id: 'p_unknown' }],
    }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});
