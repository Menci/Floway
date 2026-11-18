import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const ownerPatch = (id: string, body: unknown, rawKey: string) =>
  requestApp(`/api/keys/${id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /api/keys never exposes the server secret', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/keys', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = (await response.json()) as Array<Record<string, unknown>>;
  assertEquals(body.length, 1);
  assertEquals(Object.hasOwn(body[0]!, 'serverSecret'), false);
  assertEquals(Object.hasOwn(body[0]!, 'server_secret'), false);
});

test('PATCH /api/keys/:id stores existing upstreams even when the user ACL currently excludes one', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_a', name: 'A' }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_b', name: 'B' }));
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });

  const response = await ownerPatch(apiKey.id, { upstream_ids: ['up_a', 'up_b'] }, apiKey.key);
  assertEquals(response.status, 200);
  assertEquals((await repo.apiKeys.getById(apiKey.id))?.upstreamIds, ['up_a', 'up_b']);
});

test('PATCH /api/keys/:id keeps a stored deleted-upstream id but hides it from the response', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  // Stale id surviving from a prior write; only touched by writes that target upstream_ids.
  await repo.apiKeys.save({ ...apiKey, upstreamIds: ['up_x', 'up_gone'] });

  const response = await ownerPatch(apiKey.id, { name: 'renamed' }, apiKey.key);
  assertEquals(response.status, 200);
  assertEquals(((await response.json()) as { upstream_ids: string[] }).upstream_ids, ['up_x']);
  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.name, 'renamed');
  assertEquals(stored.upstreamIds, ['up_x', 'up_gone']);
});

test('PATCH /api/keys/:id is owner-only — admins are not privileged on other users\' keys', async () => {
  const { adminSession, apiKey } = await setupAppTest();
  // Admin session belongs to user 1; the test apiKey belongs to user 2.
  const response = await requestApp(`/api/keys/${apiKey.id}`, {
    method: 'PATCH',
    headers: { 'x-floway-session': adminSession, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'admin-rename' }),
  });
  assertEquals(response.status, 404);
});

test('POST /api/keys creates a key under the actor with optional upstream_ids', async () => {
  const { repo, apiKey } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));

  const response = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'side-key', upstream_ids: ['up_x'] }),
  });
  assertEquals(response.status, 201);
  const body = (await response.json()) as { id: string; key: string; upstream_ids: string[] | null } & Record<string, unknown>;
  assertEquals(/^sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}$/.test(body.key), true);
  assertEquals(body.upstream_ids, ['up_x']);
  assertEquals(Object.hasOwn(body, 'serverSecret'), false);
  assertEquals(Object.hasOwn(body, 'server_secret'), false);
  const stored = await repo.apiKeys.getById(body.id);
  assertExists(stored);
  assertEquals(stored.userId, apiKey.userId);
  assertEquals(/^[0-9a-f]{64}$/.test(stored.serverSecret), true);
});

test('POST /api/keys stores a custom key verbatim and rejects duplicates', async () => {
  const { repo, apiKey } = await setupAppTest();
  const response = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'custom-key', key_source: 'custom', custom_key: '  bring-your-own-key  ' }),
  });
  assertEquals(response.status, 201);
  const body = (await response.json()) as { id: string; key: string };
  assertEquals(body.key, 'bring-your-own-key');
  const stored = await repo.apiKeys.getById(body.id);
  assertExists(stored);
  assertEquals(stored.key, 'bring-your-own-key');

  const duplicate = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'duplicate-key', key_source: 'custom', custom_key: 'bring-your-own-key' }),
  });
  assertEquals(duplicate.status, 409);
});

test('POST /api/keys does not retry a generated key after a server-secret constraint', async () => {
  const { repo, apiKey } = await setupAppTest();
  const message = 'UNIQUE constraint failed: api_keys.server_secret';
  const save = vi.spyOn(repo.apiKeys, 'save').mockRejectedValue(new Error(message));
  try {
    const response = await requestApp('/api/keys', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'constraint-test', key_source: 'generate' }),
    });
    assertEquals(response.status, 500);
    assertEquals(save.mock.calls.length, 1);
    if (!(await response.text()).includes(message)) throw new Error(`expected response to expose ${message}`);
  } finally {
    save.mockRestore();
  }
});

test('DELETE /api/keys/:id succeeds when the broker close hook throws — broker outage must not block soft-delete', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('closeChannel', new Error('broker down'));

  const response = await requestApp(`/api/keys/${apiKey.id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  assertEquals(await repo.apiKeys.getById(apiKey.id), null);
});

test('PATCH /api/keys/:id positive→null closes the channel', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const response = await ownerPatch(apiKey.id, { dump_retention_seconds: null }, apiKey.key);
  assertEquals(response.status, 200);
  assertEquals(stubs.closedChannels.some(c => c.keyId === apiKey.id), true);
});
