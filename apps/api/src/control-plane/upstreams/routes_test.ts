import { test } from 'vitest';

import { assertEquals } from '../../test-assert.ts';
import { jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../test-helpers.ts';

const customConfig = {
  baseUrl: 'https://custom.example.com',
  bearerToken: 'sk-test',
  supportedEndpoints: ['/chat/completions'],
};

const azureConfig = {
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'az-secret',
  deployments: [
    {
      deployment: 'gpt-prod',
      publicModelId: 'gpt-public',
      supportedEndpoints: ['/chat/completions', '/responses'],
    },
  ],
};

const copilotConfig = {
  githubToken: 'ghu_secret',
  accountType: 'individual',
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

const authed = (adminKey: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': adminKey,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('POST /api/upstreams creates custom upstreams and redacts bearer tokens', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminKey, createBody({ flag_overrides: { 'vendor-kimi': true } })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as Record<string, any>;
  assertEquals(created.provider, 'custom');
  assertEquals(created.config.bearerToken, undefined);
  assertEquals(created.config.bearerTokenSet, true);
  assertEquals(created.config.baseUrl, 'https://custom.example.com');
  assertEquals(created.flag_overrides, { 'vendor-kimi': true });

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).bearerToken, 'sk-test');

  const list = await requestApp('/api/upstreams', { headers: { 'x-api-key': adminKey } });
  const items = (await list.json()) as Array<Record<string, any>>;
  assertEquals(items[0].config.bearerToken, undefined);
});

test('POST /api/upstreams validates Azure deployments and redacts API keys', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const invalid = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'azure', config: { ...azureConfig, deployments: [] } })));
  assertEquals(invalid.status, 400);
  const invalidBody = (await invalid.json()) as { error?: string };
  assertEquals(invalidBody.error?.includes('deployments must be a non-empty array'), true);

  const createdResp = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'azure', name: 'Azure', config: azureConfig })));
  assertEquals(createdResp.status, 201);
  const created = (await createdResp.json()) as Record<string, any>;
  assertEquals(created.provider, 'azure');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.endpoint, 'https://example.openai.azure.com');
  assertEquals(created.config.deployments[0].deployment, 'gpt-prod');
});

test('POST /api/upstreams creates Copilot upstream rows with redacted GitHub tokens', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'copilot', name: 'Copilot', config: copilotConfig })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as Record<string, any>;
  assertEquals(created.provider, 'copilot');
  assertEquals(created.config.githubToken, undefined);
  assertEquals(created.config.githubTokenSet, true);
  assertEquals(created.config.user.id, 12345);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).githubToken, 'ghu_secret');
});

test('PATCH /api/upstreams rejects provider changes and preserves the row', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminKey, createBody()));
  const created = (await create.json()) as Record<string, string>;

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ provider: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals(((await patch.json()) as { error?: string }).error, 'provider cannot be changed');
  assertEquals((await repo.upstreams.getById(created.id))?.provider, 'custom');
});

test('PATCH /api/upstreams preserves omitted secrets and invalidates model cache', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminKey, createBody()));
  const created = (await create.json()) as Record<string, string>;
  await repo.cache.set(`models_store:${created.id}`, 'stale');

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ config: { supportedEndpoints: ['/responses'] } }),
  });

  assertEquals(patch.status, 200);
  const updated = (await patch.json()) as Record<string, any>;
  assertEquals(updated.config.bearerTokenSet, true);
  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).bearerToken, 'sk-test');
  assertEquals((stored?.config as Record<string, unknown>).supportedEndpoints, ['/responses']);
  assertEquals(await repo.cache.get(`models_store:${created.id}`), null);
});

test('PATCH /api/upstreams keeps Azure as a single endpoint config', async () => {
  const { repo, adminKey } = await setupAppTest();
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
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-secret',
      deployments: [{ deployment: 'gpt-prod', supportedEndpoints: ['/v1/messages'] }],
    },
  });

  const patch = await requestApp('/api/upstreams/up_azure_single_endpoint', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({
      config: {
        deployments: [{ deployment: 'gpt-prod', supportedEndpoints: ['/responses'] }],
      },
    }),
  });

  assertEquals(patch.status, 200);
  const stored = await repo.upstreams.getById('up_azure_single_endpoint');
  assertEquals(stored?.config, {
    endpoint: 'https://example.openai.azure.com/openai/v1',
    apiKey: 'az-secret',
    deployments: [{ deployment: 'gpt-prod', supportedEndpoints: ['/responses'] }],
  });
});

test('POST /api/upstreams/:id/test probes custom, Azure, and Copilot models', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const createdCustom = await requestApp('/api/upstreams', authed(adminKey, createBody()));
  const custom = (await createdCustom.json()) as Record<string, string>;
  const createdAzure = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'azure', name: 'Azure', config: azureConfig })));
  const azure = (await createdAzure.json()) as Record<string, string>;
  const createdCopilot = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'copilot', name: 'Copilot', config: copilotConfig })));
  const copilot = (await createdCopilot.json()) as Record<string, string>;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') return jsonResponse({ object: 'list', data: [{ id: 'custom-model' }] });
      if (url.hostname === 'example.openai.azure.com' && url.pathname === '/openai/v1/models' && url.search === '') {
        return jsonResponse({ object: 'list', data: [{ id: 'azure-model' }] });
      }
      if (url.hostname === 'example.openai.azure.com' && url.pathname === '/openai/v1/chat/completions') {
        const body = (await request.json()) as Record<string, unknown>;
        assertEquals(body.model, 'gpt-prod');
        return jsonResponse({ id: 'chat_probe', choices: [{ message: { content: 'ok' } }] });
      }
      if (url.hostname === 'example.openai.azure.com' && url.pathname === '/openai/v1/responses') {
        const body = (await request.json()) as Record<string, unknown>;
        assertEquals(body.model, 'gpt-prod');
        assertEquals(body.max_output_tokens, 16);
        return jsonResponse({ id: 'resp_probe', output_text: 'ok' });
      }
      if (url.hostname === 'update.code.visualstudio.com' && url.pathname === '/api/releases/stable') {
        return jsonResponse(['1.110.1']);
      }
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') {
        assertEquals(request.headers.get('authorization'), 'token ghu_secret');
        return jsonResponse({ token: 'copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 });
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        assertEquals(request.headers.get('authorization'), 'Bearer copilot-token');
        return jsonResponse({ object: 'list', data: [{ id: 'copilot-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const customProbe = await requestApp(`/api/upstreams/${custom.id}/test`, authed(adminKey, {}));
      assertEquals(customProbe.status, 200);
      assertEquals((await customProbe.json()).models, ['custom-model']);

      const azureProbe = await requestApp(`/api/upstreams/${azure.id}/test`, authed(adminKey, {}));
      assertEquals(azureProbe.status, 200);
      const azureProbeBody = await azureProbe.json();
      assertEquals(azureProbeBody.models, ['azure-model']);
      assertEquals(azureProbeBody.probes.map((probe: any) => ({ endpoint: probe.endpoint, ok: probe.ok, status: probe.status })), [
        { endpoint: '/chat/completions', ok: true, status: 200 },
        { endpoint: '/responses', ok: true, status: 200 },
      ]);

      const copilotProbe = await requestApp(`/api/upstreams/${copilot.id}/test`, authed(adminKey, {}));
      assertEquals(copilotProbe.status, 200);
      assertEquals((await copilotProbe.json()).models, ['copilot-model']);
    },
  );
});

test('GET /api/upstream-flags returns the flag catalog and requires admin auth', async () => {
  const { adminKey, apiKey } = await setupAppTest();

  const resp = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-api-key': adminKey } });
  assertEquals(resp.status, 200);
  const catalog = (await resp.json()) as Array<Record<string, unknown>>;
  const sample = catalog.find(e => e.id === 'vendor-kimi');
  assertEquals(typeof sample?.label, 'string');
  assertEquals(Array.isArray(sample!.defaultFor), true);
  // `appliesTo` was dropped from the catalog during the Feature Flags refactor; guard against silent re-introduction.
  assertEquals('appliesTo' in sample!, false);

  const forbidden = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-api-key': apiKey.key } });
  assertEquals(forbidden.status, 403);
});
