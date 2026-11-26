import { test, vi } from 'vitest';

import { blueprintUpstreamRecord, upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import type { StoredUpstreamRecord } from '../../../src/repo/types.ts';
import { seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import { assertEquals, jsonResponse, stubUpstreamModel, withMockedFetch } from '@floway-dev/test-utils';
import type { UpstreamKind, UpstreamRecord } from '@floway-dev/upstream';

type JsonObject = Record<string, any>;

// Every action endpoint takes a `record` envelope. Two build paths: a blueprint-shaped envelope for
// create-flow tests (`record.id === ''`), and a full-record envelope for
// edit-flow tests (`record.id !== ''`) built from a repo-fetched row.
const envelopeFromRecord = (record: UpstreamRecord): Record<string, unknown> => upstreamRecordToFullJson(record) as unknown as Record<string, unknown>;

const blueprintEnvelope = (kind: UpstreamKind, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  assertEquals(typeof (await repo.upstreams.getById(created.id))?.version, 'number');

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({ kind: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals((await repo.upstreams.getById(created.id))?.kind, 'custom');
});

test('PATCH /api/upstreams reports a concurrent save as a conflict', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const created = await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json() as { id: string };
  await flushBackground();
  const replace = vi.spyOn(repo.upstreams, 'replace').mockResolvedValueOnce(null);

  const response = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: 'Concurrent edit' }),
  });
  replace.mockRestore();

  assertEquals(response.status, 409);
  assertEquals((await repo.upstreams.getById(created.id))?.name, 'Test custom upstream');
});

test('PATCH /api/upstreams preserves omitted secrets and invalidates the old catalog', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  await flushBackground();
  const created = (await create.json()) as Record<string, string>;
  // A changed model configuration cannot serve the previous catalog.
  const storedBefore = await getRecord(repo, created.id);
  await seedModelsCache(repo.upstreams, created.id, {
    version: storedBefore.version,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1,
    models: [stubUpstreamModel({ id: 'stale-model', upstreamModelId: 'stale-model', endpoints: {} })],
  });

  await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
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
      await flushBackground();
    },
  );

  const updated = await repo.upstreams.getById(created.id);
  assertEquals((updated?.config as Record<string, unknown>).apiKey, 'sk-test');
  assertEquals(updated !== null && updated.version !== storedBefore.version, true);
  assertEquals((updated?.config as Record<string, unknown>).endpoints, { openaiResponses: {} });
  assertEquals((updated?.config as Record<string, unknown>).ingressHeadersRules, [{ key: 'x-route', value: 'patched' }]);
  assertEquals(updated?.modelsCache.fetchedAt, null);
  assertEquals(await repo.upstreamModels.listByUpstream(created.id), []);
});

test('GET /api/upstreams/:id exposes cached editor rows without an upstream request', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const createdResponse = await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
    async () => {
      const res = await requestApp('/api/upstreams', authed(adminSession, createBody({
        kind: 'copilot',
        name: 'Cached Copilot',
        config: copilotConfig,
        disabled_public_model_ids: ['hidden-model'],
      })));
      await flushBackground();
      return res;
    },
  );
  assertEquals(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { id: string };
  const read = () => requestApp(`/api/upstreams/${created.id}`, { headers: { 'x-floway-session': adminSession } });

  const cold = await read();
  assertEquals(cold.status, 200);
  assertEquals(((await cold.json()) as JsonObject).cachedModels, null);

  const storedBefore = await getRecord(repo, created.id);
  await seedModelsCache(repo.upstreams, created.id, {
    version: storedBefore.version,
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [
      stubUpstreamModel({ id: 'visible-model', upstreamModelId: 'visible-model', display_name: 'Visible' }),
      stubUpstreamModel({ id: 'hidden-model', upstreamModelId: 'hidden-model' }),
    ],
  });

  await withMockedFetch(
    request => { throw new Error(`Editor read unexpectedly fetched ${request.url}`); },
    async () => {
      const response = await read();
      assertEquals(response.status, 200);
      const body = (await response.json()) as JsonObject;
      assertEquals(body.modelsCache.modelCount, 1);
      assertEquals(body.cachedModels.map((model: { publicModelId: string }) => model.publicModelId), ['hidden-model', 'visible-model']);
      const visible = body.cachedModels.find((model: { publicModelId: string }) => model.publicModelId === 'visible-model');
      assertEquals(visible.display_name, 'Visible');
      assertEquals(visible.upstreamData, undefined);
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
      const cachedModels = await repo.upstreamModels.listByUpstream(savedRecord.id);
      assertEquals(cachedModels.map(entry => entry.model.id), ['fresh-model']);
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
      await repo.upstreams.replace({
        previous: current,
        upstream: { ...current, config: { ...current.config as Record<string, unknown>, apiKey: 'changed' } },
      });
      release!(new Response('old failure', { status: 503 }));
      assertEquals((await pending).status, 409);
    },
  );
  assertEquals((await repo.upstreams.getById(record.id))?.modelsCache, { revision: null, fetchedAt: null, lastError: null });
});

test('model-listing failure belongs to the explicit Fetch after a successful Save', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const savedResponse = await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
    async () => {
      const res = await requestApp('/api/upstreams', authed(adminSession, createBody()));
      await flushBackground();
      return res;
    },
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
  assertEquals(failure.upstreamResponse, { status: 503, headers: [['content-type', 'text/plain;charset=UTF-8']], body: 'unavailable' });
  assertEquals(failedFetch.modelsCache.lastError.message, failure.message);
  assertEquals((await repo.upstreams.getById(saved.id))?.modelsCache.lastError?.message, failure.message);
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

test('DELETE /api/upstreams cascades to that upstream\'s proxy backoff rows', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: [{ id: 'p_a' }] })));
  const created = (await create.json()) as { id: string };
  const sibling = await requestApp('/api/upstreams', authed(adminSession, createBody({ name: 'Sibling', proxy_fallback_list: [{ id: 'p_a' }] })));
  const kept = (await sibling.json()) as { id: string };

  await repo.proxyBackoffs.recordDialFailure('p_a', created.id, 'tcp refused');
  await repo.proxyBackoffs.recordDialFailure('p_a', kept.id, 'tcp refused');
  assertEquals((await repo.proxyBackoffs.listAll()).length, 2);

  const del = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(del.status, 200);

  const remaining = await repo.proxyBackoffs.listAll();
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0]!.upstreamId, kept.id);
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

// Only the callback source talks to auth.openai.com, so only its egress chain
// has to resolve. A pasted document is parsed locally and must import even
// when the draft names a proxy that no longer exists.
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

test('manual Ollama usage refresh commits activity and current balance together', async () => {
  const { repo, adminSession } = await setupAppTest();
  const record = buildCustomUpstreamRecord({
    id: 'up_ollama_manual', kind: 'ollama',
    config: { baseUrl: 'https://ollama.com', apiKey: 'key', cloudUsage: true }, state: null,
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
