import { expect, test, vi } from 'vitest';

import { blueprintUpstreamRecord, upstreamRecordToFullJson, upstreamRecordToJson } from '../../../src/control-plane/upstreams/serialize.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { withMockedFetch } from '@floway-dev/test-utils';

const config = { region: 'china', apiKey: 'sk-kimi-obviously-fake-test-key' } as const;
const quota = {
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '75', resetTime: '2026-12-01T00:00:00Z' } }],
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-12-01T00:00:00Z' },
    limit_month_total: { used_ratio: 0.5, reset_time: '2026-12-01T00:00:00Z' },
    limit_month_code: { used_ratio: 0.2, reset_time: '2026-12-01T00:00:00Z' },
  },
};
const profile = { user_id: 'fake-user', nickname: 'Test account', user_level_name: 'Ultra', goods_version: 2 };
const catalog = { data: [{ id: 'catalog-model', display_name: 'Catalog model', context_length: 1_048_576, supports_reasoning: true, supports_image_in: true, supports_thinking_type: 'only', think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' } }] };
const authed = (session: string, body?: unknown, method = 'POST'): RequestInit => ({
  method: body === undefined ? 'GET' : method,
  headers: { 'x-floway-session': session, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const draft = () => ({ ...blueprintUpstreamRecord('kimi-code'), config, proxy_fallback_list: MOCKED_FETCH_EGRESS });
const kimiRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_kimi_code', kind: 'kimi-code', config, state: null, name: 'Kimi Code', enabled: true,
  usageRefreshIntervalMinutes: 5, sortOrder: 0, createdAt: '', updatedAt: '', flagOverrides: {},
  disabledPublicModelIds: [], proxyFallbackList: MOCKED_FETCH_EGRESS, modelPrefix: null, modelsCache: null, hue: 210, ...overrides,
});

test('Kimi Code blueprints, create, redaction, full edit and region patches share one config contract', async () => {
  const { adminSession, repo } = await setupAppTest();
  const blueprint = await requestApp('/api/upstreams/blueprint?kind=kimi-code', authed(adminSession));
  expect(blueprint.status).toBe(200);
  expect(await blueprint.json()).toMatchObject({ kind: 'kimi-code', config: { region: 'china', apiKey: '' }, state: null, flag_defaults: { 'vendor-kimi': true } });
  const response = await requestApp('/api/upstreams', authed(adminSession, { kind: 'kimi-code', name: 'Kimi Code', config, hue: 210, proxy_fallback_list: MOCKED_FETCH_EGRESS }));
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body).toMatchObject({ kind: 'kimi-code', config: { region: 'china', apiKeySet: true } });
  expect(body.config).not.toHaveProperty('apiKey');
  const record = (await repo.upstreams.getById(body.id))!;
  expect(record.config).toEqual(config);
  expect(upstreamRecordToJson(record).config).not.toHaveProperty('apiKey');
  expect(upstreamRecordToFullJson(record).config).toEqual(config);
  const patched = await requestApp(`/api/upstreams/${body.id}`, authed(adminSession, { config: { region: 'overseas' } }, 'PATCH'));
  expect(patched.status).toBe(200);
  expect((await repo.upstreams.getById(body.id))?.config).toEqual({ ...config, region: 'overseas' });
  const invalid = await requestApp(`/api/upstreams/${body.id}`, authed(adminSession, { config: { region: 'invalid' } }, 'PATCH'));
  expect(invalid.status).toBe(400);
});

test('draft quota and optional profile probes use coding auth and do not persist a record', async () => {
  const { adminSession, repo } = await setupAppTest();
  const before = await repo.upstreams.list();
  const paths: string[] = [];
  await withMockedFetch(request => {
    paths.push(new URL(request.url).pathname);
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    return request.url.endsWith('/usages') ? Response.json(quota) : new Response('profile not available', { status: 404 });
  }, async () => {
    const response = await requestApp('/api/upstreams/kimi-code/usage', authed(adminSession, { record: draft() }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.observation.data).toEqual(quota);
    expect(body.account).toBeNull();
    expect(body.accountError).toContain('404');
    expect(JSON.stringify(body)).not.toContain(config.apiKey);
  });
  expect(paths.sort()).toEqual(['/coding/v1/me', '/coding/v1/usages']);
  expect(await repo.upstreams.list()).toEqual(before);
});

test('saved quota and profile actions persist observations, metrics and a redacted dashboard record', async () => {
  const { adminSession, repo } = await setupAppTest();
  const record = kimiRecord();
  await saveUpstreamForTest(repo.upstreams, record);
  await withMockedFetch(request => Response.json(request.url.endsWith('/usages') ? quota : profile), async () => {
    const response = await requestApp('/api/upstreams/kimi-code/usage', authed(adminSession, { record: upstreamRecordToFullJson(record) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observation: { data: quota }, account: { data: { userId: 'fake-user', nickname: 'Test account', planName: 'Ultra' } }, accountError: null });
  });
  const saved = (await repo.upstreams.getById(record.id))!;
  expect(saved.state).toMatchObject({ usageProbe: { observation: { data: quota }, error: null }, accountProbe: { observation: { data: { planName: 'Ultra' } }, error: null } });
  expect(await repo.upstreamMetrics.listAll()).toHaveLength(2);
  expect(upstreamRecordToJson(saved)).toMatchObject({ kind: 'kimi-code', config: { region: 'china', apiKeySet: true }, state: saved.state });
});

test('Kimi Code action requires full upstream access and exposes quota failures', async () => {
  const { adminSession, apiKey } = await setupAppTest();
  const unauthorized = await requestApp('/api/upstreams/kimi-code/usage', { method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ record: draft() }) });
  expect(unauthorized.status).toBe(403);
  const wrongKind = await requestApp('/api/upstreams/kimi-code/usage', authed(adminSession, { record: { ...draft(), kind: 'custom' } }));
  expect(wrongKind.status).toBe(400);
  await withMockedFetch(request => request.url.endsWith('/usages') ? new Response('invalid authentication', { status: 401 }) : Response.json(profile), async () => {
    const failed = await requestApp('/api/upstreams/kimi-code/usage', authed(adminSession, { record: draft() }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: expect.stringContaining('401') });
  });
});

test('Kimi Code draft catalog discovery projects capabilities without writing the draft', async () => {
  const { adminSession } = await setupAppTest();
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    return Response.json(catalog);
  }, async () => {
    const response = await requestApp('/api/upstreams/preview-models', authed(adminSession, { record: draft() }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ kind: 'kimi-code', data: [{ upstreamModelId: 'catalog-model', kind: 'chat', chat: { reasoning: { mandatory: true, effort: { supported: ['low', 'high', 'max'], default: 'high' } } } }] });
    expect(body.data[0].pricing).toBeUndefined();
  });
});

test('Kimi Code credential replacement clears account observations while regional changes retain them', async () => {
  const { adminSession, repo } = await setupAppTest();
  const state = {
    usageProbe: { attemptedAt: 1, observation: { fetchedAt: 1, data: quota }, error: null },
    accountProbe: { attemptedAt: 1, observation: { fetchedAt: 1, data: { userId: 'original-account', nickname: 'Original', planName: 'Ultra' } }, error: null },
  };
  const record = kimiRecord({ state });
  await saveUpstreamForTest(repo.upstreams, record);
  for (const region of ['overseas', 'china']) {
    const response = await requestApp(`/api/upstreams/${record.id}`, authed(adminSession, { config: { region } }, 'PATCH'));
    expect(response.status).toBe(200);
    expect((await repo.upstreams.getById(record.id))?.state).toEqual(state);
  }
  for (const apiKey of ['sk-kimi-fake-replacement-key', config.apiKey]) {
    await repo.upstreams.saveState(record.id, () => state);
    const response = await requestApp(`/api/upstreams/${record.id}`, authed(adminSession, { config: { apiKey } }, 'PATCH'));
    expect(response.status).toBe(200);
    expect((await repo.upstreams.getById(record.id))?.state).toBeNull();
  }
});

test.each([false, true])('a saved-id draft key returns its own readings without persisting outcomes (failure=%s)', async fail => {
  const { adminSession, repo } = await setupAppTest();
  const record = kimiRecord();
  await saveUpstreamForTest(repo.upstreams, record);
  const saved = (await repo.upstreams.getById(record.id))!;
  const edited = { ...upstreamRecordToFullJson(saved), config: { ...config, apiKey: 'sk-kimi-fake-unsaved-key' } };
  await withMockedFetch(request => {
    expect(request.headers.get('authorization')).toBe(`Bearer ${edited.config.apiKey}`);
    return fail ? new Response('draft key rejected', { status: 401 }) : Response.json(request.url.endsWith('/usages') ? quota : profile);
  }, async () => {
    const response = await requestApp('/api/upstreams/kimi-code/usage', authed(adminSession, { record: edited }));
    expect(response.status).toBe(fail ? 502 : 200);
    if (!fail) expect(await response.json()).toMatchObject({ observation: { data: quota }, account: { data: { userId: profile.user_id } } });
  });
  expect(await repo.upstreams.getById(record.id)).toEqual(saved);
  expect(await repo.upstreamMetrics.listAll()).toEqual([]);
});

test.each([{ fail: false, restore: false }, { fail: true, restore: false }, { fail: false, restore: true }])('a key rotation discards in-flight probe outcomes (failure=$fail, restored=$restore)', async ({ fail, restore }) => {
  const { adminSession, repo } = await setupAppTest();
  const record = kimiRecord();
  await saveUpstreamForTest(repo.upstreams, record);
  const releases: Array<() => void> = [];
  await withMockedFetch(request => new Promise(resolve => {
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    releases.push(() => resolve(fail ? new Response('old key rejected', { status: 401 }) : Response.json(request.url.endsWith('/usages') ? quota : profile)));
  }), async () => {
    const pending = requestApp('/api/upstreams/kimi-code/usage', authed(adminSession, { record: upstreamRecordToFullJson(record) }));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const patched = await requestApp(`/api/upstreams/${record.id}`, authed(adminSession, { config: { apiKey: 'sk-kimi-fake-rotated-key' } }, 'PATCH'));
    expect(patched.status).toBe(200);
    if (restore) {
      const restored = await requestApp(`/api/upstreams/${record.id}`, authed(adminSession, { config: { apiKey: config.apiKey } }, 'PATCH'));
      expect(restored.status).toBe(200);
    }
    const rotated = (await repo.upstreams.getById(record.id))!;
    expect(rotated.state).toBeNull();
    releases.forEach(release => release());
    expect((await pending).status).toBe(fail ? 502 : 200);
    expect(await repo.upstreams.getById(record.id)).toEqual(rotated);
  });
  expect(await repo.upstreamMetrics.listAll()).toEqual([]);
});

test.each([{ data: [] }, { data: [{ ...catalog.data[0], id: 'kimi-for-coding', display_name: 'Unrecognized opaque name' }] }])('an empty projected catalog preserves the saved model cache: %j', async body => {
  const { adminSession, repo } = await setupAppTest();
  const record = kimiRecord();
  await saveUpstreamForTest(repo.upstreams, record);
  await withMockedFetch(() => Response.json(catalog), async () => {
    const first = await requestApp(`/api/upstreams/${record.id}/list-models`, authed(adminSession, {}));
    expect(first.status).toBe(200);
  });
  const cache = (await repo.upstreams.getById(record.id))!.modelsCache!;
  expect(cache.models).toHaveLength(1);
  await withMockedFetch(() => Response.json(body), async () => {
    const response = await requestApp(`/api/upstreams/${record.id}/list-models`, authed(adminSession, {}));
    expect(response.status).toBe(502);
  });
  const after = (await repo.upstreams.getById(record.id))!.modelsCache!;
  expect(after.models).toEqual(cache.models);
  expect(after.lastError).not.toBeNull();
});
