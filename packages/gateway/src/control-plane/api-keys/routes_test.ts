import { test, vi } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../dump/registry.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const ownerPatch = (id: string, body: unknown, rawKey: string) =>
  requestApp(`/api/keys/${id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /api/keys never exposes the server-side server secret', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/keys', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = (await response.json()) as Array<Record<string, unknown>>;
  assertEquals(body.length, 1);
  assertEquals(Object.hasOwn(body[0]!, 'serverSecret'), false);
  assertEquals(Object.hasOwn(body[0]!, 'server_secret'), false);
});

test('PATCH /api/keys/:id accepts a custom upstream whitelist + order', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_y', name: 'Y' }));

  const response = await ownerPatch(apiKey.id, { upstream_ids: ['up_y', 'up_x'] }, apiKey.key);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.upstream_ids, ['up_y', 'up_x']);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.upstreamIds, ['up_y', 'up_x']);
});

test('PATCH /api/keys/:id resets to default with upstream_ids: null', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  await ownerPatch(apiKey.id, { upstream_ids: ['up_x'] }, apiKey.key);

  const response = await ownerPatch(apiKey.id, { upstream_ids: null }, apiKey.key);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.upstream_ids, null);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.upstreamIds, null);
});

test('PATCH /api/keys/:id rejects an empty upstream_ids array', async () => {
  const { apiKey } = await setupAppTest();
  const response = await ownerPatch(apiKey.id, { upstream_ids: [] }, apiKey.key);
  assertEquals(response.status, 400);
});

test('PATCH /api/keys/:id rejects unknown upstream ids with a descriptive error', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_known', name: 'Known' }));

  const response = await ownerPatch(apiKey.id, { upstream_ids: ['up_known', 'up_ghost'] }, apiKey.key);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(typeof body.error, 'string');
  if (!String(body.error).includes('up_ghost')) {
    throw new Error(`expected error to mention up_ghost; got ${body.error}`);
  }
});

test('PATCH /api/keys/:id rejects entries outside the user-level upstream cap', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A' }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B' }));
  // Tighten the user cap to up_a only; the key owner cannot expand to up_b.
  const owner = await repo.users.getById(apiKey.userId);
  if (!owner) throw new Error('owner missing');
  await repo.users.save({ ...owner, upstreamIds: ['up_a'] });

  const allowed = await ownerPatch(apiKey.id, { upstream_ids: ['up_a'] }, apiKey.key);
  assertEquals(allowed.status, 200);

  const blocked = await ownerPatch(apiKey.id, { upstream_ids: ['up_a', 'up_b'] }, apiKey.key);
  assertEquals(blocked.status, 400);
  const body = (await blocked.json()) as { error?: string };
  if (!String(body.error).includes('up_b')) {
    throw new Error(`expected error to mention up_b; got ${body.error}`);
  }
});

test('PATCH /api/keys/:id rejects duplicate ids inside the whitelist', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  const response = await ownerPatch(apiKey.id, { upstream_ids: ['up_x', 'up_x'] }, apiKey.key);
  assertEquals(response.status, 400);
});

test('PATCH /api/keys/:id leaves name unchanged when only upstream_ids is sent', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  await ownerPatch(apiKey.id, { upstream_ids: ['up_x'] }, apiKey.key);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.name, apiKey.name);
});

test('PATCH /api/keys/:id leaves upstream_ids unchanged (stale ids included) when only name is sent', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  // Stale id surviving from a prior write; only touched by writes that target upstream_ids.
  await repo.apiKeys.save({ ...apiKey, upstreamIds: ['up_x', 'up_gone'] });

  const response = await ownerPatch(apiKey.id, { name: 'renamed' }, apiKey.key);
  assertEquals(response.status, 200);
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
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));

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

test('POST /api/keys mints a generated key when key_source is generate', async () => {
  const { repo, apiKey } = await setupAppTest();
  const response = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'generated-key', key_source: 'generate', dump_retention_seconds: 3600 }),
  });
  assertEquals(response.status, 201);
  const body = (await response.json()) as { id: string; key: string; dump_retention_seconds: number | null };
  assertEquals(/^sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}$/.test(body.key), true);
  assertEquals(body.dump_retention_seconds, 3600);

  const stored = await repo.apiKeys.getById(body.id);
  assertExists(stored);
  assertEquals(stored.dumpRetentionSeconds, 3600);
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

test.each([
  'UNIQUE constraint failed: api_keys.server_secret',
  'CHECK constraint failed: length(server_secret) = 64',
])('POST /api/keys exposes non-key database constraints: %s', async message => {
  const { repo, apiKey } = await setupAppTest();
  const save = vi.spyOn(repo.apiKeys, 'save').mockRejectedValue(new Error(message));
  try {
    const response = await requestApp('/api/keys', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'constraint-test', key_source: 'custom', custom_key: 'custom-value' }),
    });
    assertEquals(response.status, 500);
    if (!(await response.text()).includes(message)) throw new Error(`expected response to expose ${message}`);
  } finally {
    save.mockRestore();
  }
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

test('POST /api/keys rejects malformed custom key requests', async () => {
  const { apiKey } = await setupAppTest();
  const missing = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'custom-key', key_source: 'custom' }),
  });
  assertEquals(missing.status, 400);

  const unexpected = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'generated-key', custom_key: 'not-allowed' }),
  });
  assertEquals(unexpected.status, 400);

  const unknownSource = await requestApp('/api/keys', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'removed-source', key_source: 'floway' }),
  });
  assertEquals(unknownSource.status, 400);
});

test('POST /api/keys/:id/rotate mints a generated key by default', async () => {
  const { apiKey, repo } = await setupAppTest();
  const response = await requestApp(`/api/keys/${apiKey.id}/rotate`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { key: string } & Record<string, unknown>;
  assertEquals(/^sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}$/.test(body.key), true);
  assertEquals(Object.hasOwn(body, 'serverSecret'), false);
  assertEquals(Object.hasOwn(body, 'server_secret'), false);
  assertEquals((await repo.apiKeys.getById(apiKey.id))?.serverSecret, apiKey.serverSecret);
});

test('POST /api/keys/:id/rotate accepts a caller-provided key when key_source is custom', async () => {
  const { apiKey } = await setupAppTest();

  const missing = await requestApp(`/api/keys/${apiKey.id}/rotate`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ key_source: 'custom' }),
  });
  assertEquals(missing.status, 400);

  const rotated = await requestApp(`/api/keys/${apiKey.id}/rotate`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ key_source: 'custom', custom_key: 'new-custom-key' }),
  });
  assertEquals(rotated.status, 200);
  const body = (await rotated.json()) as { key: string };
  assertEquals(body.key, 'new-custom-key');
});

test('PATCH /api/keys/:id sets dump_retention_seconds on the column', async () => {
  const { repo, apiKey } = await setupAppTest();
  const response = await ownerPatch(apiKey.id, { dump_retention_seconds: 3600 }, apiKey.key);
  assertEquals(response.status, 200);
  const body = (await response.json()) as { dump_retention_seconds: number | null };
  assertEquals(body.dump_retention_seconds, 3600);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.dumpRetentionSeconds, 3600);
});

test('PATCH /api/keys/:id clears dump_retention_seconds back to null', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });

  const response = await ownerPatch(apiKey.id, { dump_retention_seconds: null }, apiKey.key);
  assertEquals(response.status, 200);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.dumpRetentionSeconds, null);
});

test('PATCH /api/keys/:id rejects zero and negative dump_retention_seconds', async () => {
  const { apiKey } = await setupAppTest();
  assertEquals((await ownerPatch(apiKey.id, { dump_retention_seconds: 0 }, apiKey.key)).status, 400);
  assertEquals((await ownerPatch(apiKey.id, { dump_retention_seconds: -1 }, apiKey.key)).status, 400);
});

test('DELETE /api/keys/:id soft-deletes the key', async () => {
  const { repo, apiKey } = await setupAppTest();
  const response = await requestApp(`/api/keys/${apiKey.id}`, {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);

  const stored = await repo.apiKeys.getById(apiKey.id);
  // getById hides soft-deleted rows; falling back to listIncludingDeleted
  // confirms the row was tombstoned rather than dropped.
  assertEquals(stored, null);
  const allKeys = await repo.apiKeys.listIncludingDeleted();
  const deleted = allKeys.find(k => k.id === apiKey.id);
  assertExists(deleted);
  assertEquals(typeof deleted.deletedAt, 'string');
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
  // The store purge still ran.
  assertEquals(stubs.purgedAll.includes(apiKey.id), true);
  // The soft-delete still landed.
  assertEquals(await repo.apiKeys.getById(apiKey.id), null);
});

test('PATCH /api/keys/:id positive→null retention purges + closes the channel', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const response = await ownerPatch(apiKey.id, { dump_retention_seconds: null }, apiKey.key);
  assertEquals(response.status, 200);
  assertEquals(stubs.purgedAll.includes(apiKey.id), true);
  assertEquals(stubs.closedChannels.some(c => c.keyId === apiKey.id), true);
});

test('PATCH /api/keys/:id positive→null succeeds when the broker close hook throws', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('closeChannel', new Error('broker down'));

  const response = await ownerPatch(apiKey.id, { dump_retention_seconds: null }, apiKey.key);
  assertEquals(response.status, 200);
  assertEquals(stubs.purgedAll.includes(apiKey.id), true);
});

test('PATCH /api/keys/:id positive→smaller positive purges expired with the new window', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 7200 });
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);

  const response = await ownerPatch(apiKey.id, { dump_retention_seconds: 1800 }, apiKey.key);
  assertEquals(response.status, 200);
  const call = stubs.purgedExpired.find(c => c.keyId === apiKey.id);
  assertExists(call);
  assertEquals(call.retentionSeconds, 1800);
  assertEquals(stubs.closedChannels.some(c => c.keyId === apiKey.id), false);
});
