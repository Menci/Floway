import { expect, test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const request = (path: string, session: string, init: RequestInit = {}) => requestApp(`/api${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', 'x-floway-session': session, ...init.headers },
});

const modelUseRecord = (principalId: number, upstreamId: string, sortOrder = 0) => ({
  principal: { kind: 'user' as const, id: principalId },
  scope: { kind: 'upstream' as const, upstreamId },
  sortOrder,
  values: { 'Model.Use': true },
});

test('access-record list and writes require admin', async () => {
  const { apiKey } = await setupAppTest();
  const list = await requestApp('/api/access-records', { headers: { 'x-api-key': apiKey.key } });
  const create = await requestApp('/api/access-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify(modelUseRecord(2, 'up_a')),
  });
  assertEquals(list.status, 403);
  assertEquals(create.status, 403);
});

test('access records create, replace their structured scope, list, and delete', async () => {
  const { adminSession } = await setupAppTest();
  const created = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify(modelUseRecord(2, 'up_a', 1)),
  });
  assertEquals(created.status, 201);
  const record = (await created.json()) as { id: number };

  const replaced = await request(`/access-records/${record.id}`, adminSession, {
    method: 'PUT',
    body: JSON.stringify({
      principal: { kind: 'user', id: 2 },
      scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-[45]$' } },
      sortOrder: 0,
      values: { 'Model.Use': false },
    }),
  });
  assertEquals(replaced.status, 200);
  expect(await replaced.json()).toMatchObject({
    id: record.id,
    scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-[45]$' } },
    values: { 'Model.Use': false },
  });

  const list = await request('/access-records', adminSession);
  assertEquals(((await list.json()) as Array<{ id: number }>).some(candidate => candidate.id === record.id), true);
  assertEquals((await request(`/access-records/${record.id}`, adminSession, { method: 'DELETE' })).status, 200);
});

test('access-record writes reject unknown principals, invalid scope permissions, and duplicate order', async () => {
  const { adminSession } = await setupAppTest();
  const unknown = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify(modelUseRecord(999, 'up_a')),
  });
  assertEquals(unknown.status, 400);

  const invalid = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify({
      principal: { kind: 'user', id: 2 },
      scope: { kind: 'user', userId: 2 },
      sortOrder: 0,
      values: { 'Model.Use': true },
    }),
  });
  assertEquals(invalid.status, 400);

  assertEquals((await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify(modelUseRecord(2, 'up_a', 4)),
  })).status, 201);
  const duplicateOrder = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify(modelUseRecord(2, 'up_b', 4)),
  });
  assertEquals(duplicateOrder.status, 400);
});

test('access resolve uses group grants and returns the effective level map', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: 2 });
  const group = await repo.groups.create('Operators');
  await repo.groups.replaceMembers(group.id, [2]);
  await repo.accessRecords.save({
    principal: { kind: 'group', id: group.id },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': true, 'Upstream.Edit': 'models' },
  });

  const response = await request('/access-resolve', adminSession, {
    method: 'POST',
    body: JSON.stringify({ userId: 2, target: { kind: 'upstream', upstreamId: 'up_a' } }),
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    values: { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' },
  });
});
