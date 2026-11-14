import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import { seedModelsCache, storedModelsRefreshIdentity } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { projectCustomModels } from '@floway-dev/provider-custom';
import { assertEquals } from '@floway-dev/test-utils';

const customRecord = () => buildCustomUpstreamRecord({
  id: 'up_restricted',
  name: 'Restricted',
  proxyFallbackList: [{ id: 'proxy_a' }],
  config: {
    baseUrl: 'https://secret.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-secret',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [{ key: 'x-secret', value: 'value' }],
    pathOverrides: { '/chat/completions': '/private/chat' },
    modelsFetch: { enabled: true, endpoint: '/private/models' },
    models: [{ upstreamModelId: 'gpt-5', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
  },
});

const grant = async (
  repo: import('../../repo/memory.ts').InMemoryRepo,
  userId: number,
  level: 'models' | 'full',
  upstreamId = 'up_restricted',
) => await repo.accessRecords.save({
  principal: { kind: 'user', id: userId },
  scope: { kind: 'upstream', upstreamId },
  sortOrder: 0,
  values: { 'Upstream.Edit': level },
});

test('upstreams without Edit permission are absent from list and detail routes', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());

  const list = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(list.status, 200);
  assertEquals(await list.json(), []);
  assertEquals(detail.status, 404);
});

test('the list never exposes provider credentials even to a Full editor', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await grant(repo, apiKey.userId, 'full');

  const response = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const listed = (await response.json() as Array<Record<string, any>>)[0]!;
  assertEquals(listed.config.apiKey, undefined);
  assertEquals(listed.config.apiKeySet, true);
  assertEquals(listed.config.ingressHeadersRules[0], { key: 'x-secret', value: 'value' });
  const stored = await repo.upstreams.getById('up_restricted');
  assertEquals((stored?.config as Record<string, unknown> | undefined)?.apiKey, 'sk-secret');
});

test('reorder preserves sparse slots inside the actor\'s complete contiguous Full segment', async () => {
  const { repo, apiKey } = await setupAppTest();
  for (const [id, sortOrder] of [['hidden-before', 0], ['full-a', 10], ['full-b', 30], ['hidden-after', 40]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id, name: id, sortOrder }));
  }
  await grant(repo, apiKey.userId, 'full', 'full-a');
  await grant(repo, apiKey.userId, 'full', 'full-b');

  const response = await requestApp('/api/upstreams/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ expectedIds: ['full-a', 'full-b'], ids: ['full-b', 'full-a'] }),
  });

  assertEquals(response.status, 200);
  const testIds = new Set(['hidden-before', 'full-a', 'full-b', 'hidden-after']);
  assertEquals((await repo.upstreams.list()).filter(record => testIds.has(record.id)).map(({ id, sortOrder }) => [id, sortOrder]), [
    ['hidden-before', 0],
    ['full-b', 10],
    ['full-a', 30],
    ['hidden-after', 40],
  ]);
});

test('reorder rejects a selection that crosses a non-Full upstream', async () => {
  const { repo, apiKey } = await setupAppTest();
  for (const [id, sortOrder] of [['full-a', 0], ['locked', 10], ['full-b', 20]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id, name: id, sortOrder }));
  }
  await grant(repo, apiKey.userId, 'full', 'full-a');
  await grant(repo, apiKey.userId, 'full', 'full-b');

  const response = await requestApp('/api/upstreams/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ expectedIds: ['full-a', 'full-b'], ids: ['full-b', 'full-a'] }),
  });

  assertEquals(response.status, 409);
  const testIds = new Set(['full-a', 'locked', 'full-b']);
  assertEquals((await repo.upstreams.list()).filter(record => testIds.has(record.id)).map(record => record.id), ['full-a', 'locked', 'full-b']);
});

test('the list exposes distinct reorder groups across an invisible non-Full boundary', async () => {
  const { repo, apiKey } = await setupAppTest();
  for (const [id, sortOrder] of [['full-a', 0], ['hidden', 10], ['full-b', 20]] as const) {
    await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id, name: id, sortOrder }));
  }
  await grant(repo, apiKey.userId, 'full', 'full-a');
  await grant(repo, apiKey.userId, 'full', 'full-b');

  const response = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const body = await response.json() as Array<{ id: string; reorderGroup: string | null }>;
  assertEquals(body.filter(record => record.id === 'full-a' || record.id === 'full-b').map(record => [record.id, record.reorderGroup]), [
    ['full-a', 'full-a'],
    ['full-b', 'full-b'],
  ]);
});

test('the general update endpoint rejects sort_order changes', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await grant(repo, apiKey.userId, 'full');
  const initialSortOrder = (await repo.upstreams.getById('up_restricted'))!.sortOrder;

  const response = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ sort_order: 999 }),
  });

  assertEquals(response.status, 400);
  assertEquals((await repo.upstreams.getById('up_restricted'))?.sortOrder, initialSortOrder);
});

test('Upstream.Audit exposes a redacted record in the listing, detail, and metrics route', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_restricted' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });
  await repo.upstreamMetrics.record({ upstreamId: 'up_restricted', name: 'quota.remaining', labels: {}, timestamp: 10_000, value: 25 });

  const list = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const listed = (await list.json() as Array<Record<string, any>>)[0]!;
  assertEquals(listed.editLevel, 'off');
  assertEquals(listed.audit, true);
  assertEquals(listed.modelUse, false);
  assertEquals(listed.config.baseUrl, 'https://secret.example.com');
  assertEquals(listed.config.apiKey, undefined);

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  const body = await detail.json();
  assertEquals(body.editLevel, 'off');
  assertEquals(body.audit, true);
  assertEquals(body.config.baseUrl, 'https://secret.example.com');
  assertEquals(body.config.apiKey, undefined);
  assertEquals(body.cachedModels, null);
  assertEquals(body.modelsCache.modelCount, null);

  const metrics = await requestApp('/api/upstream-metrics?upstream_id=up_restricted&start=0&end=60000&step=60000', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(metrics.status, 200);
  assertEquals((await metrics.json()).records.length, 1);
});

test('Upstream.Audit sees the cached catalog count without receiving catalog rows', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await seedModelsCache(repo.upstreams, 'up_restricted', await storedModelsRefreshIdentity(repo.upstreams, 'up_restricted'), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: projectCustomModels((await repo.upstreams.getById('up_restricted'))!),
  });
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_restricted' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });

  const list = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const listed = (await list.json() as Array<Record<string, any>>)[0]!;
  assertEquals(listed.modelUse, false);
  assertEquals(listed.modelsCache.modelCount, 1);

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  const body = await detail.json();
  assertEquals(body.modelsCache.modelCount, 1);
  assertEquals(body.cachedModels, null);
});

test('a disabled upstream keeps Model.Use coverage so the listing can use its cached count', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, { ...customRecord(), enabled: false });
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_restricted' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true, 'Model.Use': true },
  });

  const response = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const listed = (await response.json() as Array<Record<string, any>>)[0]!;
  assertEquals(listed.modelUse, true);
});

test('an upstream Model.Use grant and Edit.Models expose the same catalog visibility in list and detail', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.proxies.save({ id: 'proxy_a', name: 'Proxy A', url: 'http://127.0.0.1:8080', dialTimeoutSeconds: null });
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_restricted' },
    sortOrder: 0,
    values: { 'Model.Use': true, 'Upstream.Edit': 'models' },
  });

  const list = await requestApp('/api/upstreams', { headers: { 'x-api-key': apiKey.key } });
  const listed = (await list.json() as Array<Record<string, any>>)[0]!;
  assertEquals(listed.modelUse, true);

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  const body = await detail.json();
  assertEquals(body.cachedModels, null);
  assertEquals(body.modelsCache.modelCount, listed.modelsCache.modelCount);
});

test('Upstream.Audit and Upstream.Edit.Models share the complete redacted serializer', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_restricted' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true, 'Upstream.Edit': 'models' },
  });

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  const body = await detail.json();
  assertEquals(body.editLevel, 'models');
  assertEquals(body.audit, true);
  assertEquals(body.config.baseUrl, 'https://secret.example.com');
  assertEquals(body.config.apiKey, undefined);
  assertEquals(body.config.pathOverrides, { '/chat/completions': '/private/chat' });
});

test('Upstream.Edit.Models returns a redacted record and only accepts model fields', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.proxies.save({ id: 'proxy_a', name: 'Proxy A', url: 'http://127.0.0.1:8080', dialTimeoutSeconds: null });
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await grant(repo, apiKey.userId, 'models');

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(detail.status, 200);
  const body = await detail.json();
  assertEquals(body.editLevel, 'models');
  assertEquals(body.audit, false);
  assertEquals(body.config.baseUrl, 'https://secret.example.com');
  assertEquals(body.config.apiKey, undefined);
  assertEquals(body.config.apiKeySet, true);
  assertEquals(body.config.modelsFetch, { enabled: true, endpoint: '/private/models' });
  assertEquals(body.config.pathOverrides, { '/chat/completions': '/private/chat' });
  assertEquals(body.config.ingressHeadersRules, [{ key: 'x-secret', value: 'value' }]);
  assertEquals(body.proxy_fallback_list, [{ id: 'proxy_a' }]);
  assertEquals((await requestApp('/api/upstream-metrics?upstream_id=up_restricted&start=0&end=60000&step=60000', { headers: { 'x-api-key': apiKey.key } })).status, 404);

  const allowed = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({
      disabled_public_model_ids: ['old-model'],
      config: { models: [], modelsFetch: { enabled: false } },
    }),
  });
  assertEquals(allowed.status, 200);
  const stored = await repo.upstreams.getById('up_restricted');
  expect(stored).toMatchObject({
    disabledPublicModelIds: ['old-model'],
    modelPrefix: null,
    config: {
      baseUrl: 'https://secret.example.com',
      apiKey: 'sk-secret',
      pathOverrides: { '/chat/completions': '/private/chat' },
      modelsFetch: { enabled: false, endpoint: '/private/models' },
    },
  });

  const blockedName = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ name: 'Renamed' }),
  });
  const blockedEndpoint = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ config: { modelsFetch: { enabled: true, endpoint: '/stolen' } } }),
  });
  const blockedPrefix = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ model_prefix: { prefix: 'team/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] } }),
  });
  assertEquals(blockedName.status, 403);
  assertEquals(blockedEndpoint.status, 403);
  assertEquals(blockedPrefix.status, 403);
  const readableProxies = await requestApp('/api/proxy-options?upstream_id=up_restricted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(readableProxies.status, 200);
  assertEquals(await readableProxies.json(), [{ id: 'proxy_a', name: 'Proxy A' }]);
});

test('Upstream.Edit.Full returns raw configuration, accepts full patches, and lists proxy options', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.proxies.save({ id: 'proxy_a', name: 'Proxy A', url: 'http://127.0.0.1:8080', dialTimeoutSeconds: null });
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await grant(repo, apiKey.userId, 'full');

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(detail.status, 200);
  const body = await detail.json();
  assertEquals(body.editLevel, 'full');
  assertEquals(body.audit, false);
  assertEquals(body.config.baseUrl, 'https://secret.example.com');
  assertEquals(body.config.apiKey, 'sk-secret');

  const updated = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ name: 'Renamed', config: { baseUrl: 'https://next.example.com' } }),
  });
  assertEquals(updated.status, 200);
  expect(await repo.upstreams.getById('up_restricted')).toMatchObject({ name: 'Renamed', config: { baseUrl: 'https://next.example.com', apiKey: 'sk-secret' } });

  const proxies = await requestApp('/api/proxy-options?upstream_id=up_restricted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(proxies.status, 200);
  assertEquals(await proxies.json(), [{ id: 'proxy_a', name: 'Proxy A' }]);
});

test('Codex JSON import preview is available to a signed-in non-admin', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/upstreams/codex/import/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ raw_json: JSON.stringify({ accounts: [] }) }),
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { candidates: [] });
});

test('model discovery previews a persisted record only for Full and keeps create drafts admin-only', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  const response = await requestApp('/api/upstreams/preview-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ record: { ...customRecord(), id: 'up_restricted', proxy_fallback_list: [] } }),
  });
  assertEquals(response.status, 404);
});

test('provider credential actions require Full and keep create drafts admin-only', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  const actionBody = (id: string) => ({
    record: { id, kind: 'claude-code', config: {}, state: {}, proxy_fallback_list: [] },
    challenge: 'challenge',
    state: 'state',
  });
  const call = (id: string) => requestApp('/api/upstreams/claude-code/oauth/authorize-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify(actionBody(id)),
  });

  await grant(repo, apiKey.userId, 'models');
  assertEquals((await call('up_restricted')).status, 404);
  await grant(repo, apiKey.userId, 'full');
  assertEquals((await call('up_restricted')).status, 200);
  assertEquals((await call('')).status, 403);
});

test('provider credential actions require a persisted upstream even with a dangling Full ACL', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_deleted' },
    sortOrder: 0,
    values: { 'Upstream.Edit': 'full' },
  });

  const response = await requestApp('/api/upstreams/claude-code/oauth/authorize-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({
      record: { id: 'up_deleted', kind: 'claude-code', config: {}, state: {}, proxy_fallback_list: [] },
      challenge: 'challenge',
      state: 'state',
    }),
  });
  assertEquals(response.status, 404);
});

test('proxy options treat a dangling upstream ACL as an absent upstream', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_deleted' },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });

  const response = await requestApp('/api/proxy-options?upstream_id=up_deleted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 404);
});

test('upstream options apply key, audit, and all view predicates', async () => {
  const { repo, apiKey } = await setupAppTest();
  const upstream = customRecord();
  await saveUpstreamForTest(repo.upstreams, upstream);
  const stored = await repo.upstreams.getById(upstream.id);
  if (!stored) throw new Error('upstream missing');
  await seedModelsCache(repo.upstreams, upstream.id, await storedModelsRefreshIdentity(repo.upstreams, upstream.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1,
    models: projectCustomModels(stored),
  });
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstreamModel', upstreamId: upstream.id, model: { kind: 'regex', value: '^gpt-[45]$' } },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });

  const keyView = await requestApp('/api/upstream-options?view=key', { headers: { 'x-api-key': apiKey.key } });
  const auditBefore = await requestApp('/api/upstream-options?view=audit', { headers: { 'x-api-key': apiKey.key } });
  const all = await requestApp('/api/upstream-options?view=all', { headers: { 'x-api-key': apiKey.key } });
  assertEquals((await keyView.json()).map((item: { id: string }) => item.id), [upstream.id]);
  assertEquals(await auditBefore.json(), []);
  assertEquals(all.status, 403);

  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: upstream.id },
    sortOrder: 0,
    values: { 'Upstream.Audit': true },
  });
  const auditAfter = await requestApp('/api/upstream-options?view=audit', { headers: { 'x-api-key': apiKey.key } });
  assertEquals((await auditAfter.json()).map((item: { id: string }) => item.id), [upstream.id]);
});

test('key upstream options hide an upstream whose only granted model is operator-disabled', async () => {
  const { repo, apiKey } = await setupAppTest();
  const upstream = { ...customRecord(), disabledPublicModelIds: ['gpt-5'] };
  await saveUpstreamForTest(repo.upstreams, upstream);
  const stored = await repo.upstreams.getById(upstream.id);
  if (!stored) throw new Error('upstream missing');
  await seedModelsCache(repo.upstreams, upstream.id, await storedModelsRefreshIdentity(repo.upstreams, upstream.id), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1,
    models: projectCustomModels(stored),
  });
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstreamModel', upstreamId: upstream.id, model: { kind: 'exact', value: 'gpt-5' } },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });

  const response = await requestApp('/api/upstream-options?view=key', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(await response.json(), []);
});
