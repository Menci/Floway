import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
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
    models: [],
  },
});

const grant = async (
  repo: import('../../repo/memory.ts').InMemoryRepo,
  userId: number,
  level: 'models' | 'full',
) => await repo.accessRecords.save({
  principal: { kind: 'user', id: userId },
  scope: { kind: 'upstream', upstreamId: 'up_restricted' },
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

test('Upstream.Edit.Models returns a redacted record and only accepts model fields', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, customRecord());
  await grant(repo, apiKey.userId, 'models');

  const detail = await requestApp('/api/upstreams/up_restricted', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(detail.status, 200);
  const body = await detail.json();
  assertEquals(body.editLevel, 'models');
  assertEquals(body.config.baseUrl, '');
  assertEquals(body.config.apiKey, undefined);
  assertEquals(body.config.modelsFetch, { enabled: true });
  assertEquals(body.config.pathOverrides, {});
  assertEquals(body.config.ingressHeadersRules, []);
  assertEquals(body.proxy_fallback_list, []);

  const allowed = await requestApp('/api/upstreams/up_restricted', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({
      disabled_public_model_ids: ['old-model'],
      model_prefix: { prefix: 'team/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
      config: { models: [], modelsFetch: { enabled: false } },
    }),
  });
  assertEquals(allowed.status, 200);
  const stored = await repo.upstreams.getById('up_restricted');
  expect(stored).toMatchObject({
    disabledPublicModelIds: ['old-model'],
    modelPrefix: { prefix: 'team/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
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
  assertEquals(blockedName.status, 403);
  assertEquals(blockedEndpoint.status, 403);
  assertEquals((await requestApp('/api/proxy-options?upstream_id=up_restricted', { headers: { 'x-api-key': apiKey.key } })).status, 404);
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
