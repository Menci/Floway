import { test, vi } from 'vitest';

import { blueprintUpstreamRecord, upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import type { StoredUpstreamRecord } from '../../../src/repo/types.ts';
import { modelsRefreshIdentity, seedModelsCache, seedModelsCacheError, storedModelsRefreshIdentity } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

// Every action endpoint takes a `record` envelope. Two build paths: a blueprint-shaped envelope for
// create-flow tests (`record.id === ''`), and a full-record envelope for
// edit-flow tests (`record.id !== ''`) built from a repo-fetched row.
const envelopeFromRecord = (record: UpstreamRecord): Record<string, unknown> => upstreamRecordToFullJson(record) as unknown as Record<string, unknown>;

const blueprintEnvelope = (kind: UpstreamProviderKind, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...blueprintUpstreamRecord(kind),
  proxy_fallback_list: MOCKED_FETCH_EGRESS,
  ...overrides,
});

const customConfig = {
  baseUrl: 'https://custom.example.com',
  ingressHeadersRules: [],
  apiKey: 'sk-test',
  endpoints: { openaiChatCompletions: {} },
};

const copilotConfig = {
  githubHost: 'github.com',
  githubToken: 'ghu_secret',
  user: {
    id: 12345,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/octo.png',
  },
};

const createBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'custom',
  name: 'Test custom upstream',
  hue: 210,
  config: customConfig,
  flag_overrides: {},
  proxy_fallback_list: MOCKED_FETCH_EGRESS,
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

  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({
    config: {
      ...customConfig,
      ingressHeadersRules: [
        { key: 'X-Request-ID', value: null },
        { key: 'X-Empty', value: '' },
        { key: 'X-Route', value: 'configured' },
      ],
    },
    flag_overrides: { 'vendor-kimi': true },
  })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.kind, 'custom');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.baseUrl, 'https://custom.example.com');
  assertEquals(created.config.ingressHeadersRules, [
    { key: 'x-request-id', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'configured' },
  ]);
  assertEquals(created.flag_overrides, { 'vendor-kimi': true });

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).apiKey, 'sk-test');
  assertEquals((stored?.config as Record<string, unknown>).ingressHeadersRules, created.config.ingressHeadersRules);

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  const items = (await list.json()) as JsonObject[];
  assertEquals(items[0].config.apiKey, undefined);
});

test('PATCH /api/upstreams rejects kind changes and preserves the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;
  assertEquals((await repo.upstreams.getById(created.id))?.configVersion, 1);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({ kind: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals(((await patch.json()) as { error?: string }).error, 'kind cannot be changed');
  assertEquals((await repo.upstreams.getById(created.id))?.kind, 'custom');
});

test('PATCH /api/upstreams reports a concurrent save as a conflict', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json() as { id: string };
  const replace = vi.spyOn(repo.upstreams, 'replaceForModels').mockResolvedValueOnce(null);

  const response = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: 'Concurrent edit' }),
  });
  replace.mockRestore();

  assertEquals(response.status, 409);
  assertEquals((await response.json() as { error: string }).error, `Upstream ${created.id} changed concurrently`);
  assertEquals((await repo.upstreams.getById(created.id))?.name, 'Test custom upstream');
});

test('PATCH /api/upstreams preserves omitted secrets and invalidates the old catalog without fetching', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;
  // A changed model configuration cannot serve the previous catalog.
  await seedModelsCache(repo.upstreams, created.id, await getRefreshIdentity(repo, created.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1,
    models: [stubProviderModel({ id: 'stale-model', upstreamModelId: 'stale-model', endpoints: {} })],
  });

  await withMockedFetch(
    request => { throw new Error(`Save unexpectedly fetched ${request.url}`); },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({
          config: {
            endpoints: { openaiResponses: {} },
            ingressHeadersRules: [{ key: 'X-Route', value: 'patched' }],
          },
        }),
      });
      assertEquals(patch.status, 200);
      const response = (await patch.json()) as JsonObject;
      assertEquals(response.config.apiKey, 'sk-test');
      assertEquals(response.modelsCache, { fetchedAt: null, lastError: null, modelCount: null });
    },
  );

  const updated = await repo.upstreams.getById(created.id);
  assertEquals((updated?.config as Record<string, unknown>).apiKey, 'sk-test');
  assertEquals(updated?.configVersion, 2);
  assertEquals((updated?.config as Record<string, unknown>).endpoints, { openaiResponses: {} });
  assertEquals((updated?.config as Record<string, unknown>).ingressHeadersRules, [{ key: 'x-route', value: 'patched' }]);

  assertEquals(updated?.modelsCache, null);
});

test('GET /api/upstreams attaches models-cache freshness to every row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Three upstreams cover the three cache states: no row, warm row, warm row
  // with a follow-up failure annotation.
  const baseRow = {
    kind: 'custom' as const,
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { baseUrl: 'https://a.example.com', apiKey: 'x', endpoints: { openaiChatCompletions: {} }, ingressHeadersRules: [] },
    state: null,
  };
  const freshRecord = { ...baseRow, id: 'up_fresh', name: 'Fresh', sortOrder: 0 };
  const warmRecord = { ...baseRow, id: 'up_warm', name: 'Warm', sortOrder: 1 };
  const failedRecord = { ...baseRow, id: 'up_failed', name: 'Failed', sortOrder: 2 };
  await saveUpstreamForTest(repo.upstreams, freshRecord);
  await saveUpstreamForTest(repo.upstreams, warmRecord);
  await saveUpstreamForTest(repo.upstreams, failedRecord);

  await seedModelsCache(repo.upstreams, 'up_warm', await storedModelsRefreshIdentity(repo.upstreams, 'up_warm'), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'm1', upstreamModelId: 'm1', endpoints: {} })],
  });
  await seedModelsCache(repo.upstreams, 'up_failed', await storedModelsRefreshIdentity(repo.upstreams, 'up_failed'), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'm1', upstreamModelId: 'm1', endpoints: {} })],
  });
  await seedModelsCacheError(repo.upstreams, 'up_failed', await storedModelsRefreshIdentity(repo.upstreams, 'up_failed'), { message: 'boom', at: 1_700_000_500_000 });

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const items = (await list.json()) as JsonObject[];
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  assertEquals(byId.up_fresh.modelsCache, { fetchedAt: null, lastError: null, modelCount: null });
  assertEquals(byId.up_warm.modelsCache, { fetchedAt: 1_700_000_000_000, lastError: null, modelCount: 1 });
  assertEquals(byId.up_failed.modelsCache, {
    fetchedAt: 1_700_000_000_000,
    lastError: { message: 'boom', at: 1_700_000_500_000 },
    modelCount: 1,
  });
});

test('GET /api/upstreams/:id exposes cached editor rows without an upstream request', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const createdResponse = await requestApp('/api/upstreams', authed(adminSession, createBody({
    kind: 'copilot',
    name: 'Cached Copilot',
    config: copilotConfig,
    disabled_public_model_ids: ['hidden-model'],
  })));
  assertEquals(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { id: string };
  const read = () => requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });

  const cold = await read();
  assertEquals(cold.status, 200);
  assertEquals(((await cold.json()) as JsonObject).cachedModels, null);

  await seedModelsCache(repo.upstreams, created.id, await storedModelsRefreshIdentity(repo.upstreams, created.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [
      stubProviderModel({ id: 'visible-model', upstreamModelId: 'visible-model', display_name: 'Visible' }),
      stubProviderModel({ id: 'hidden-model', upstreamModelId: 'hidden-model' }),
    ],
  });

  await withMockedFetch(
    request => { throw new Error(`Editor read unexpectedly fetched ${request.url}`); },
    async () => {
      const response = await read();
      assertEquals(response.status, 200);
      const body = (await response.json()) as JsonObject;
      assertEquals(body.modelsCache.modelCount, 1);
      assertEquals(body.cachedModels.map((model: { publicModelId: string }) => model.publicModelId), ['visible-model', 'hidden-model']);
      assertEquals(body.cachedModels[0].display_name, 'Visible');
      assertEquals(body.cachedModels[0].providerData, undefined);
    },
  );
});

test('POST /api/upstreams/:id/list-models reads the saved config and publishes a fresh snapshot', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const savedRecord: UpstreamRecord = {
    id: 'up_refresh',
    kind: 'custom',
    name: 'Refresh Custom',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { ...customConfig, apiKey: 'sk-refresh' },
    state: null,
  };
  await saveUpstreamForTest(repo.upstreams, savedRecord);

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
      const resp = await requestApp(`/api/upstreams/${savedRecord.id}/list-models`, {
        method: 'POST',
        headers: { 'x-floway-session': adminSession },
      });
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<{ upstreamModelId?: string }>; modelsCache: { fetchedAt: number | null; modelCount: number | null } };
      assertEquals(body.data.map(m => m.upstreamModelId), ['fresh-model']);
      assertEquals(body.modelsCache.modelCount, 1);
      assertEquals(typeof body.modelsCache.fetchedAt, 'number');
      assertEquals(upstreamCalls, 1);
      const cached = (await repo.upstreams.getById(savedRecord.id))?.modelsCache;
      assertEquals(cached?.models.map((model: { id: string }) => model.id), ['fresh-model']);
      assertEquals(cached?.discovered?.map(model => model.upstreamModelId), ['fresh-model']);
      const stored = await requestApp(`/api/upstreams/${savedRecord.id}`, { headers: { 'x-floway-session': adminSession } });
      assertEquals(stored.status, 200);
      assertEquals(((await stored.json()) as JsonObject).cachedModels.map((model: { upstreamModelId: string }) => model.upstreamModelId), ['fresh-model']);
      assertEquals(upstreamCalls, 1);
    },
  );
});

test('saved model fetch rejects a config edit that wins before a failed response', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const record = buildCustomUpstreamRecord();
  await saveUpstreamForTest(repo.upstreams, record);
  let release: ((response: Response) => void) | undefined;
  await withMockedFetch(
    () => new Promise<Response>(resolve => { release = resolve; }),
    async () => {
      const pending = requestApp(`/api/upstreams/${record.id}/list-models`, { method: 'POST', headers: { 'x-floway-session': adminSession } });
      await vi.waitFor(() => assertEquals(typeof release, 'function'));
      const current = await repo.upstreams.getById(record.id);
      if (current === null) throw new Error('upstream missing');
      await repo.upstreams.replaceForModels({ previous: current, upstream: { ...current, config: { ...current.config as Record<string, unknown>, apiKey: 'changed' } } });
      release!(new Response('old failure', { status: 503 }));
      assertEquals((await pending).status, 409);
    },
  );
  assertEquals((await repo.upstreams.getById(record.id))?.modelsCache, null);
});

test('model-listing failure belongs to the explicit Fetch after a successful Save', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const savedResponse = await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
    () => requestApp('/api/upstreams', authed(adminSession, createBody())),
  );
  assertEquals(savedResponse.status, 201);
  const saved = (await savedResponse.json()) as JsonObject;
  assertEquals(saved.modelsCache.lastError, null);
  const fetchResponse = await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
    () => requestApp(`/api/upstreams/${saved.id}/list-models`, { method: 'POST', headers: { 'x-floway-session': adminSession } }),
  );
  assertEquals(fetchResponse.status, 502);
  const failedFetch = await fetchResponse.json() as JsonObject;
  const failure = failedFetch.error;
  assertEquals(failure.code, 'upstream_model_listing_failed');
  assertEquals(failure.message.startsWith('HTTP 503: unavailable'), true);
  assertEquals(failure.upstreamResponse, { status: 503, headers: [['content-type', 'text/plain;charset=UTF-8']], body: 'unavailable' });
  assertEquals(failedFetch.modelsCache.lastError.message, failure.message);
  assertEquals((await repo.upstreams.getById(saved.id))?.modelsCache?.lastError?.failureCount, 1);
  assertEquals((await repo.upstreams.getById(saved.id))?.modelsCache?.lastError?.message, failure.message);
});

// --- ChatGPT routes ---
//
// The auth.json import path lets us drive the OAuth ingestion deterministically
// without mocking the token-exchange roundtrip: parseChatGPTTokenClaims decodes
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

// The `~/.codex/auth.json` envelope, which the import path detects by its
// `tokens` key and exposes as a single selectable source.
const chatgptJsonImport = (overrides: Record<string, unknown> = {}) => ({
  json: {
    raw_json: JSON.stringify({
      tokens: {
        access_token: 'at_test',
        refresh_token: 'rt_test',
        id_token: fakeIdToken({}),
      },
      ...overrides,
    }),
    source_index: 0,
  },
});

// Two-step create flow: (1) exchange endpoint yields a ChatGPT config+state
// patch from the fake auth.json blob, (2) POST /api/upstreams persists the
// merged draft. Mirrors the SPA editor's exchange-then-save flow so tests
// touching subsequent ChatGPT actions see the same row a real user would
// have.
const createChatGPTUpstreamViaExchange = async (adminSession: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> => {
  const exchange = await requestApp('/api/upstreams/chatgpt/import/exchange', authed(adminSession, {
    record: blueprintEnvelope('chatgpt'),
    json: chatgptJsonImport(overrides).json,
  }));
  if (exchange.status !== 200) throw new Error(`ChatGPT exchange failed: ${exchange.status} ${await exchange.text()}`);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };
  const create = await withMockedFetch(
    () => jsonResponse({ error: 'forbidden' }, 403),
    () => requestApp('/api/upstreams', authed(adminSession, {
      kind: 'chatgpt',
      name: 'ChatGPT',
      hue: 210,
      config: patch.config,
      state: patch.state,
      proxy_fallback_list: MOCKED_FETCH_EGRESS,
    })),
  );
  if (create.status !== 201) throw new Error(`ChatGPT create failed: ${create.status} ${await create.text()}`);
  return (await create.json()) as { id: string };
};

const getRecord = async (repo: { upstreams: { getById: (id: string) => Promise<StoredUpstreamRecord | null> } }, id: string): Promise<StoredUpstreamRecord> => {
  const record = await repo.upstreams.getById(id);
  if (!record) throw new Error(`Expected upstream ${id} to exist`);
  return record;
};

const getRefreshIdentity = async (repo: { upstreams: { getById: (id: string) => Promise<StoredUpstreamRecord | null> } }, id: string) => {
  const record = await getRecord(repo, id);
  return modelsRefreshIdentity(record);
};

test('POST /api/upstreams/chatgpt/import/preview lists selectable candidates and no credential material', async () => {
  const { adminSession } = await setupAppTest();
  const raw = JSON.stringify({
    accounts: [
      { platform: 'anthropic', type: 'oauth', credentials: { access_token: 'ignore-me' } },
      {
        platform: 'openai',
        type: 'oauth',
        name: 'Primary',
        credentials: {
          access_token: 'opaque',
          refresh_token: 'rt_secret_preview',
          email: 'person@example.test',
        },
      },
    ],
  });

  await withMockedFetch(
    () => { throw new Error('preview must not fetch'); },
    async () => {
      const resp = await requestApp('/api/upstreams/chatgpt/import/preview', authed(adminSession, { raw_json: raw }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { candidates: unknown };
      assertEquals(body.candidates, [{
        sourceIndex: 1,
        name: 'Primary',
        email: 'person@example.test',
        chatgptAccountId: null,
        chatgptUserId: null,
        planType: null,
        renewable: true,
        expiresAt: null,
        issues: [],
      }]);
      const serialized = JSON.stringify(body);
      assertEquals(serialized.includes('opaque'), false);
      assertEquals(serialized.includes('rt_secret_preview'), false);
    },
  );
});

test('POST /api/upstreams/chatgpt/oauth/refresh flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createChatGPTUpstreamViaExchange(adminSession);

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp('/api/upstreams/chatgpt/oauth/refresh', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      // 400, not 502: the upstream answered — it's the stored credential
      // that's dead. Not 401 either, since the dashboard's auth client
      // treats any 401 as a logout signal.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.toLowerCase().includes('re-run oauth'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; state_message?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].state_message, 'string');
});

test('POST /api/upstreams/chatgpt/reset-credits refreshes once after a definite upstream 401', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createChatGPTUpstreamViaExchange(adminSession);
  let listAttempts = 0;

  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      if (path === '/backend-api/wham/rate-limit-reset-credits') {
        listAttempts += 1;
        if (listAttempts === 1) return new Response('expired', { status: 401 });
        assertEquals(request.headers.get('authorization'), 'Bearer at_rotated');
        return jsonResponse({ available_count: 0, credits: [] });
      }
      if (path === '/oauth/token') {
        return jsonResponse({
          access_token: 'at_rotated', refresh_token: 'rt_rotated',
          id_token: fakeIdToken({}), expires_in: 3600,
        });
      }
      throw new Error(`unexpected ChatGPT request to ${path}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/chatgpt/reset-credits', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      assertEquals(listAttempts, 2);
    },
  );
  const updated = await getRecord(repo, created.id);
  const updatedState = updated.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(updatedState.accounts[0].refresh_token, 'rt_rotated');
});

test('POST /api/upstreams/chatgpt/reset-credits/consume sends the stable key and invalidates stale quota', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createChatGPTUpstreamViaExchange(adminSession, { tokens: { access_token: 'at_test', refresh_token: 'rt_test', id_token: fakeIdToken({}), expires_at: '2100-01-01T00:00:00Z' } });
  const stored = await getRecord(repo, created.id);
  const state = stored.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.saveState(created.id, current => ({
    ...(current as Record<string, unknown>),
    accounts: state.accounts.map(account => ({
      ...account,
      quotaSnapshot: {
        codex: { fetchedAt: Date.now(), data: { observed_at: '2026-06-17T00:00:00Z', primary_used_percent: 100 } },
      },
    })),
  }));

  const paths: string[] = [];
  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith('/consume')) {
        assertEquals(await request.json(), { redeem_request_id: 'redeem-stable', credit_id: 'credit-1' });
        return jsonResponse({ code: 'reset', windows_reset: 2 });
      }
      return jsonResponse({ available_count: 0, credits: [] });
    },
    async () => {
      const resp = await requestApp('/api/upstreams/chatgpt/reset-credits/consume', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
        credit_id: 'credit-1',
        idempotency_key: 'redeem-stable',
      }));
      assertEquals(resp.status, 200);
      const body = await resp.json() as { outcome: { code: string }; reset_credits: { available_count: number }; refresh_error: string | null };
      assertEquals(body, { outcome: { code: 'reset' }, reset_credits: { available_count: 0, credits: [] }, refresh_error: null });
    },
  );
  assertEquals(paths, [
    '/backend-api/wham/rate-limit-reset-credits/consume',
    '/backend-api/wham/rate-limit-reset-credits',
  ]);
  const updated = await getRecord(repo, created.id);
  const updatedState = updated.state as { accounts: Array<{ quotaSnapshot: unknown }> };
  assertEquals(updatedState.accounts[0].quotaSnapshot, null);
});

const claudeCodeProfileBody = {
  account: { uuid: 'acc-uuid-1', email: 'alice@example.com' },
  organization: { uuid: 'org-uuid-1', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
};

const claudeCodeCredentialsJson = () => JSON.stringify({
  claudeAiOauth: {
    accessToken: 'cli_at',
    refreshToken: 'cli_rt',
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
});

// SPA-mirroring two-step create for claude-code: (1) exchange yields a
// config+state patch (identity fetched via mocked profile call), (2) POST
// /api/upstreams persists the merged draft.
const createClaudeCodeUpstreamViaExchange = async (adminSession: string): Promise<{ id: string }> => {
  const exchange = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    () => requestApp('/api/upstreams/claude-code/oauth/exchange', authed(adminSession, {
      record: blueprintEnvelope('claude-code'),
      credentials_json: claudeCodeCredentialsJson(),
    })),
  );
  if (exchange.status !== 200) throw new Error(`claude-code exchange failed: ${exchange.status} ${await exchange.text()}`);
  const { patch } = (await exchange.json()) as { patch: { config: unknown; state: unknown } };
  const create = await requestApp('/api/upstreams', authed(adminSession, {
    kind: 'claude-code',
    name: 'Claude Code',
    hue: 210,
    config: patch.config,
    state: patch.state,
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
  }));
  if (create.status !== 201) throw new Error(`claude-code create failed: ${create.status} ${await create.text()}`);
  return (await create.json()) as { id: string };
};

test('PATCH /api/upstreams rejects ChatGPT account ID changes', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createChatGPTUpstreamViaExchange(adminSession);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { accounts: [{ chatgptAccountId: 'acc_other' }] } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.includes('only be changed by re-importing'), true);
});

test('PATCH /api/upstreams rejects config edits on a copilot row', async () => {
  const { adminSession, copilotUpstream } = await setupAppTest();

  const patch = await requestApp(`/api/upstreams/${copilotUpstream.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { githubHost: 'github.com', githubToken: 'ghu_hijack', user: { login: 'x', id: 0, avatar_url: '', name: null } } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('copilot'), true);
});

// --- proxy_fallback_list ---
//
// The list has set semantics — duplicates are dropped silently before
// storage. Order is meaningful at dial time. Both POST and PATCH normalize
// the list so the wire response matches what GET returns afterwards.

test('POST /api/upstreams normalises proxy_fallback_list duplicates so the response matches what GET returns', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }, { id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  // Without the API-layer normalize, the response would echo the duplicates
  // while the saved row only kept one of each — operators would see a
  // different list on POST vs the next GET.
  assertEquals(created.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);

  const get = await requestApp('/api/upstreams', authed(adminSession));
  const list = (await get.json()) as JsonObject[];
  const fresh = list.find(u => u.id === created.id);
  assertEquals(fresh!.proxy_fallback_list, [{ id: 'p_fallback' }, { id: 'direct_connect' }, { id: 'direct_fetch' }]);
});

test('GET /api/upstreams drops a fallback entry whose proxy is gone, keeping direct transports', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_live', name: 'Live', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_live' }, { id: 'direct_fetch' }] })));
  const created = (await create.json()) as { id: string };
  // A proxy delete is refused while an upstream still names it, so reach past
  // the route to reproduce a raced delete or a hand-edited row.
  const stored = await repo.upstreams.getById(created.id);
  await saveUpstreamForTest(repo.upstreams, { ...stored!, proxyFallbackList: [{ id: 'p_gone' }, { id: 'p_live' }, { id: 'direct_fetch' }] });

  const single = await requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(single.status, 200);
  assertEquals(((await single.json()) as JsonObject).proxy_fallback_list, [{ id: 'p_live' }, { id: 'direct_fetch' }]);

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  const rows = (await list.json()) as JsonObject[];
  assertEquals(rows.find(row => row.id === created.id)?.proxy_fallback_list, [{ id: 'p_live' }, { id: 'direct_fetch' }]);

  // The stored row keeps the entry: only a write that targets the list rewrites it.
  assertEquals((await repo.upstreams.getById(created.id))?.proxyFallbackList.map(entry => entry.id), ['p_gone', 'p_live', 'direct_fetch']);
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

// The edit form's in-progress proxy_fallback_list travels on the action
// envelope and must win over the persisted list.
test('POST /api/upstreams/claude-code/oauth/refresh honors the record.proxy_fallback_list over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stash a real proxy id so the persisted list has a non-direct entry; the
  // envelope below points at a different (unknown) id, so a 400 from the
  // route proves the envelope's list won — not the persisted row.
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  // Persist a non-direct fallback list so a successful default-path refresh
  // would route through `p_real`. The envelope's list should win.
  await saveUpstreamForTest(repo.upstreams, { ...(await getRecord(repo, created.id)), proxyFallbackList: [{ id: 'p_real' }] });

  const envelope = envelopeFromRecord(await getRecord(repo, created.id));
  envelope.proxy_fallback_list = [{ id: 'p_unknown' }];
  const resp = await requestApp('/api/upstreams/claude-code/oauth/refresh', authed(adminSession, { record: envelope }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

// Only the callback source talks to auth.openai.com, so it is the only one
// whose egress chain has to resolve. A pasted document is parsed locally and
// must import even when the draft names a proxy that no longer exists.
test('POST /api/upstreams/chatgpt/import/exchange rejects a record.proxy_fallback_list referencing an unknown proxy id on the callback source', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/chatgpt/import/exchange',
    authed(adminSession, {
      record: blueprintEnvelope('chatgpt', { proxy_fallback_list: [{ id: 'p_unknown' }] }),
      callback: { code: 'AUTH_CODE', verifier: 'TEST_VERIFIER' },
    }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/chatgpt/import/exchange imports a pasted document without resolving egress', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/chatgpt/import/exchange',
    authed(adminSession, {
      record: blueprintEnvelope('chatgpt', { proxy_fallback_list: [{ id: 'p_unknown' }] }),
      ...chatgptJsonImport(),
    }),
  );
  assertEquals(resp.status, 200);
});

const usageProbeBody = {
  five_hour: { utilization: 0.42, resets_at: '2026-06-19T20:00:00Z' },
  seven_day: { utilization: 0.10, resets_at: '2026-06-25T18:00:00Z' },
  seven_day_sonnet: { utilization: 0.05, resets_at: '2026-06-25T18:00:00Z' },
};

test('POST /api/upstreams/claude-code/probe returns Anthropic body verbatim and persists into state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);

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
      const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, {
        record: envelopeFromRecord(await getRecord(repo, created.id)),
      }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as {
        fetched_at: string;
        body: Record<string, unknown>;
        patch: { state: { accounts: Array<{ refreshToken: string; accessToken?: { token: string }; usageProbeSnapshot?: { data: Record<string, unknown> } }> } };
      };
      assertEquals(typeof body.fetched_at, 'string');
      assertEquals(body.body, usageProbeBody);
      // The patch's state slot MUST be a full account slice, not a partial
      // `{ usageProbeSnapshot }`; frontend applyPatch does whole-slot
      // replacement and a partial would clobber refreshToken/accessToken.
      assertEquals(body.patch.state.accounts[0].refreshToken, 'cli_rt');
      assertEquals(body.patch.state.accounts[0].accessToken?.token, 'cli_at');
      assertEquals(body.patch.state.accounts[0].usageProbeSnapshot?.data, usageProbeBody);
    },
  );

  // The persisted snapshot is observable via the next GET /api/upstreams.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ usageProbeSnapshot: { fetchedAt: number; data: Record<string, unknown> } | null }> };
  assertEquals(storedState.accounts[0].usageProbeSnapshot?.data, usageProbeBody);
  assertEquals(typeof storedState.accounts[0].usageProbeSnapshot?.fetchedAt, 'number');
});

// A minimal but shape-complete `/copilot_internal/user` body. The quota
// endpoint projects it onto the same snapshot shape the data-plane headers
// produce, so both sources render identically on the dashboard.
const sampleCopilotQuotaBody = {
  access_type_sku: 'copilot_pro',
  analytics_tracking_id: 'trk-1',
  assigned_date: '2026-01-01T00:00:00Z',
  can_signup_for_limited: false,
  chat_enabled: true,
  copilot_plan: 'individual',
  organization_login_list: [],
  organization_list: [],
  quota_reset_date: '2026-07-01',
  quota_reset_date_utc: '2026-07-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { entitlement: 300, overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: 'chat', quota_remaining: 300, remaining: 300, unlimited: false },
    completions: { entitlement: 0, overage_count: 0, overage_permitted: false, percent_remaining: 100, quota_id: 'completions', quota_remaining: 0, remaining: 0, unlimited: true },
    premium_interactions: { entitlement: 300, overage_count: 0, overage_permitted: false, percent_remaining: 90, quota_id: 'premium_interactions', quota_remaining: 270, remaining: 270, unlimited: false },
  },
};

// Action endpoints take a full-record envelope but only patch the fields the
// action owns; proxy_fallback_list is a per-request routing override that an
// action never writes back.
test('POST /api/upstreams/claude-code/probe does not persist record.proxy_fallback_list mutations', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_persisted', name: 'Persisted', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await createClaudeCodeUpstreamViaExchange(adminSession);
  // Persist a non-default fallback list — this is what MUST survive the
  // probe. The envelope's list serves ONLY as a per-request routing
  // override; the probe endpoint never writes it back.
  await saveUpstreamForTest(repo.upstreams, { ...(await getRecord(repo, created.id)), proxyFallbackList: [{ id: 'p_persisted' }] });
  const originalList = (await getRecord(repo, created.id)).proxyFallbackList;

  const envelope = envelopeFromRecord(await getRecord(repo, created.id));
  envelope.proxy_fallback_list = [{ id: 'direct_fetch' }];

  await withMockedFetch(
    () => jsonResponse(usageProbeBody),
    async () => {
      const resp = await requestApp('/api/upstreams/claude-code/probe', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, originalList);
});

test('GET /api/upstreams/blueprint serves the record a new upstream starts as with provider flag defaults filled in', async () => {
  const { adminSession } = await setupAppTest();

  // The blueprint is the create form's opening record, so it carries the
  // starting values as well as the shape: a custom upstream opens on an
  // OpenAI-compatible chat endpoint with catalog fetching on. Serialization is
  // a static registry lookup so no provider asserter runs against it.
  // Credentials are editable empty strings, not redacted `*Set` projections.
  const custom = (await (await requestApp('/api/upstreams/blueprint?kind=custom', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(custom.config.apiKey, '');
  assertEquals(custom.config.endpoints, { openaiChatCompletions: {} });
  assertEquals(custom.config.ingressHeadersRules, []);
  assertEquals(custom.config.modelsFetch, { enabled: true, authStyle: 'bearer' });
  const azure = (await (await requestApp('/api/upstreams/blueprint?kind=azure', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(azure.config.models, []);
  const ollama = (await (await requestApp('/api/upstreams/blueprint?kind=ollama', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(ollama.config.apiKey, '');

  // `flag_defaults` on the wire is the whole point of the blueprint;
  // assert it lands on every kind so the dashboard's "Inherit → on/off"
  // pill has data to render before Save.
  for (const kind of ['copilot', 'custom', 'azure', 'chatgpt', 'claude-code', 'ollama']) {
    const preview = (await (await requestApp(`/api/upstreams/blueprint?kind=${kind}`, { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
    assertEquals(typeof preview.flag_defaults['strip-billing-attribution'], 'boolean');
  }

  // Spot-check the two provider-computed decisions we care about at the
  // wire boundary. copilot keeps `strip-billing-attribution` on so the
  // Claude Code billing block never reaches its OpenAI-compatible upstream
  // prompt cache; claude-code keeps it off so plan-tier attribution reaches
  // Anthropic verbatim.
  const copilotPreview = (await (await requestApp('/api/upstreams/blueprint?kind=copilot', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(copilotPreview.flag_defaults['strip-billing-attribution'], true);
  assertEquals(copilotPreview.flag_defaults['rewrite-mid-conv-system-to-user'], false);
  assertEquals(copilotPreview.flag_defaults['rewrite-disallowed-mid-conv-system-to-user'], false);
  const ccPreview = (await (await requestApp('/api/upstreams/blueprint?kind=claude-code', { headers: { 'x-floway-session': adminSession } })).json()) as JsonObject;
  assertEquals(ccPreview.flag_defaults['strip-billing-attribution'], false);
  assertEquals(ccPreview.flag_defaults['rewrite-disallowed-mid-conv-system-to-user'], true);
});

test('GET upstream list and detail repair legacy ChatGPT expiry per family without rewriting state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await createChatGPTUpstreamViaExchange(adminSession);
  const stored = await getRecord(repo, created.id);
  const primary = {
    observed_at: '2026-06-05T00:00:00.000Z',
    primary_used_percent: 100,
    primary_window_minutes: 300,
    primary_reset_after_at: '2026-06-05T01:00:00.000Z',
    secondary_used_percent: 35,
    secondary_window_minutes: 10080,
    secondary_reset_after_at: '2026-06-09T00:00:00.000Z',
    ratelimited_until: '2026-06-09T00:00:00.000Z',
  };
  const secondary = { ...primary, primary_used_percent: 35, secondary_used_percent: 100 };
  const { ratelimited_until: _until, ...successful } = primary;
  const state = structuredClone(stored.state) as JsonObject;
  state.accounts[0].quotaSnapshot = Object.fromEntries(
    Object.entries({ primary, secondary, successful }).map(([key, data]) => [key, { fetchedAt: 1, data }]),
  );
  await repo.upstreams.saveState(created.id, () => state);

  for (const path of ['/api/upstreams', `/api/upstreams/${created.id}`]) {
    const resp = await requestApp(path, { headers: { 'x-floway-session': adminSession } });
    assertEquals(resp.status, 200);
    const json = await resp.json() as JsonObject;
    const body = path === '/api/upstreams' ? (json as JsonObject[]).find(item => item.id === created.id) : json;
    assertEquals(body?.chatgpt_quota, {
      primary: { ...primary, ratelimited_until: primary.primary_reset_after_at },
      secondary,
      successful,
    });
  }
  assertEquals((await getRecord(repo, created.id)).state, state);
});

test('POST /api/upstreams/copilot/quota projects the GitHub body and persists it into upstream state', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.github.com/copilot_internal/user') {
        return jsonResponse(sampleCopilotQuotaBody);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { reset_at: string; quotas: Record<string, JsonObject> };
      assertEquals(body.reset_at, '2026-07-01T00:00:00.000Z');
      assertEquals(Object.keys(body.quotas).sort(), ['chat', 'completions', 'premium_interactions']);
      assertEquals(body.quotas.premium_interactions, {
        entitlement: 300,
        overage_count: 0,
        overage_permitted: false,
        percent_remaining: 90,
        quota_remaining: 270,
        unlimited: false,
      });
    },
  );

  // The refresh writes the same slot the data plane fills, so the dashboard
  // reads one snapshot regardless of which source observed the seat last.
  const stored = await repo.upstreams.getById(copilotUpstream.id);
  const snapshot = (stored?.state as { quotaSnapshot: { data: { quotas: Record<string, JsonObject> } } }).quotaSnapshot;
  assertEquals(snapshot.data.quotas.premium_interactions.quota_remaining, 270);
});

// The passive header path refuses to write an empty snapshot so a good
// reading survives; the operator refresh has to honour the same contract, or
// pressing Refresh against a body on the pre-2026-06 shape — which carries no
// `quota_snapshots` — would erase what the headers harvested.
test('POST /api/upstreams/copilot/quota leaves the stored snapshot alone when the body reports no buckets', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  const stored = await repo.upstreams.getById(copilotUpstream.id);
  if (!stored) throw new Error('copilot upstream missing');
  const harvested = {
    fetchedAt: 1_700_000_000_000,
    data: {
      observed_at: '2026-08-01T00:00:00.000Z',
      reset_at: '2026-09-01T00:00:00.000Z',
      quotas: { chat: { entitlement: 50, overage_count: 0, overage_permitted: false, percent_remaining: 80, quota_remaining: 40, unlimited: false } },
    },
  };
  await repo.upstreams.saveState(
    copilotUpstream.id,
    current => ({ ...(current as Record<string, unknown>), quotaSnapshot: harvested }),
  );

  const envelope = envelopeFromRecord(await getRecord(repo, copilotUpstream.id));
  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://api.github.com/copilot_internal/user') {
        return jsonResponse({ access_type_sku: 'free_limited_copilot', copilot_plan: 'individual', limited_user_quotas: { chat: 500, completions: 3876 }, monthly_quotas: { chat: 500, completions: 4000 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/copilot/quota', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
      assertEquals(await resp.json(), null);
    },
  );

  const after = await repo.upstreams.getById(copilotUpstream.id);
  assertEquals((after?.state as { quotaSnapshot: unknown }).quotaSnapshot, harvested);
});

test('usage refresh defaults off and can be opted in and out without changing model configuration', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await requestApp('/api/upstreams', authed(adminSession, createBody({ kind: 'copilot', config: copilotConfig, state: null })));
  assertEquals(created.status, 201);
  const body = await created.json() as JsonObject;
  assertEquals(body.usage_refresh_interval_minutes, 0);
  const version = (await repo.upstreams.getById(body.id))!.configVersion;
  for (const interval of [1, 15, 0]) {
    const response = await requestApp(`/api/upstreams/${body.id}`, {
      ...authed(adminSession, { usage_refresh_interval_minutes: interval }), method: 'PATCH',
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json() as JsonObject).usage_refresh_interval_minutes, interval);
    const saved = (await repo.upstreams.getById(body.id))!;
    assertEquals(saved.usageRefreshIntervalMinutes, interval);
    assertEquals(saved.configVersion, version);
  }
});

test('manual Ollama usage refresh commits activity and current balance together', async () => {
  const { repo, adminSession } = await setupAppTest();
  const record = buildCustomUpstreamRecord({
    id: 'up_ollama_manual', kind: 'ollama',
    config: { baseUrl: 'https://ollama.com', apiKey: 'key', cloudUsage: true, models: [] }, state: null,
  });
  await saveUpstreamForTest(repo.upstreams, record);
  const paths: string[] = [];
  await withMockedFetch(request => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === '/api/usage') return jsonResponse({ range: '7d', scope: 'self', from: '2026-10-04T00:00:00Z', until: '2026-10-11T04:00:00Z', totals: { request_count: 15, usage_usd: 3.5 } });
    if (path === '/api/balance') return jsonResponse({ included: { balance_usd: 42, allowance_usd: 60, period: { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' } }, purchased: { balance_usd: 25 } });
    if (path === '/api/me') return jsonResponse({ name: 'Tester', email: 'test@example.com', plan: 'pro' });
    throw new Error(`Unexpected Ollama request ${path}`);
  }, async () => {
    const response = await requestApp('/api/upstreams/ollama/usage', authed(adminSession, { record: envelopeFromRecord(record) }));
    assertEquals(response.status, 200);
    const body = await response.json() as JsonObject;
    assertEquals(body.observation.data.usage.totals.usage_usd, 3.5);
    assertEquals(body.observation.data.balance.purchased.balance_usd, 25);
    const state = (await repo.upstreams.getById(record.id))!.state as JsonObject;
    assertEquals(state.usageProbe.observation.data.usage.totals.usage_usd, 3.5);
    assertEquals(state.usageProbe.observation.data.balance.included.balance_usd, 42);
  });
  assertEquals(paths.toSorted(), ['/api/balance', '/api/me', '/api/usage']);
});
