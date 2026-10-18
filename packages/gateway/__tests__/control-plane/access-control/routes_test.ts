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

test('access-record listing is actor-scoped while writes require admin', async () => {
  const { apiKey } = await setupAppTest();
  const list = await requestApp('/api/access-records', { headers: { 'x-api-key': apiKey.key } });
  const create = await requestApp('/api/access-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify(modelUseRecord(2, 'up_a')),
  });
  assertEquals(list.status, 200);
  assertEquals(((await list.json()) as Array<{ principal: { kind: string; id: number } }>).every(record => record.principal.kind === 'user' && record.principal.id === 2), true);
  assertEquals(create.status, 403);
});

test('non-admin access listing includes only the actor and their groups', async () => {
  const { apiKey, repo } = await setupAppTest();
  const ownGroup = await repo.groups.create('Operators', 120);
  const otherGroup = await repo.groups.create('Others', 180);
  await repo.groups.replaceMembers(ownGroup.id, [apiKey.userId]);
  await repo.groups.replaceMembers(otherGroup.id, [1]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: apiKey.userId }, sortOrder: 0, values: { 'User.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: ownGroup.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: otherGroup.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });

  const response = await requestApp('/api/access-records', { headers: { 'x-api-key': apiKey.key } });
  const records = await response.json() as Array<{ principal: { kind: string; id: number } }>;
  assertEquals(records.every(record => record.principal.kind === 'user' ? record.principal.id === apiKey.userId : record.principal.id === ownGroup.id), true);
  assertEquals(records.some(record => record.principal.kind === 'group' && record.principal.id === otherGroup.id), false);
});

test('an unfiltered non-admin listing is still restricted to self and joined groups', async () => {
  const { apiKey, repo } = await setupAppTest();
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [apiKey.userId]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: apiKey.userId }, sortOrder: 0, values: { 'User.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  await repo.accessRecords.save({ principal: { kind: 'user', id: 1 }, scope: { kind: 'users' }, sortOrder: 0, values: { 'User.Audit': true } });
  const response = await requestApp('/api/access-records', { headers: { 'x-api-key': apiKey.key } });
  const records = await response.json() as Array<{ principal: { kind: string; id: number } }>;
  expect(new Set(records.map(record => `${record.principal.kind}:${record.principal.id}`))).toEqual(new Set([
    `user:${apiKey.userId}`,
    `group:${group.id}`,
  ]));
});

test('non-admin access resolve rejects another principal and accepts self or a member group', async () => {
  const { apiKey, repo } = await setupAppTest();
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [apiKey.userId]);
  const call = (principal: { kind: 'user' | 'group'; id: number }) => requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal, scope: { kind: 'upstreams' } }),
  });
  assertEquals((await call({ kind: 'user', id: apiKey.userId })).status, 200);
  assertEquals((await call({ kind: 'group', id: group.id })).status, 200);
  const groupResponse = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId: apiKey.userId } }),
  });
  assertEquals(groupResponse.status, 200);
  assertEquals((await call({ kind: 'user', id: 1 })).status, 404);
  assertEquals((await call({ kind: 'group', id: group.id + 1 })).status, 404);
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
  const fixedOrder = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify(modelUseRecord(2, 'up_b', 4)),
  });
  assertEquals(fixedOrder.status, 201);
  const modelRecord = { principal: { kind: 'user', id: 2 }, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 4, values: { 'Model.Use': true } };
  assertEquals((await request('/access-records', adminSession, { method: 'POST', body: JSON.stringify(modelRecord) })).status, 201);
  const duplicateOrder = await request('/access-records', adminSession, { method: 'POST', body: JSON.stringify({ ...modelRecord, scope: { ...modelRecord.scope, model: { kind: 'regex', value: '^gpt-' } } }) });
  assertEquals(duplicateOrder.status, 409);
});

test('access resolve uses group grants and returns the effective level map', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: 2 });
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [2]);
  await repo.accessRecords.save({
    principal: { kind: 'group', id: group.id },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': true, 'Upstream.Edit': 'models' },
  });

  const response = await request('/access-resolve', adminSession, {
    method: 'POST',
    body: JSON.stringify({ principal: { kind: 'user', id: 2 }, scope: { kind: 'upstream', upstreamId: 'up_a' } }),
  });
  assertEquals(response.status, 200);
  expect(await response.json()).toMatchObject({
    values: { 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' },
  });
});

test('access resolve can exclude the edited record to expose inherited state', async () => {
  const { adminSession, repo } = await setupAppTest();
  const record = await repo.accessRecords.save({
    principal: { kind: 'user', id: 2 },
    scope: { kind: 'upstream', upstreamId: 'up_a' },
    sortOrder: 0,
    values: { 'Model.Use': false },
  });
  const body = { principal: { kind: 'user', id: 2 }, scope: { kind: 'upstream' as const, upstreamId: 'up_a' } };
  const current = await request('/access-resolve', adminSession, { method: 'POST', body: JSON.stringify(body) });
  const inherited = await request('/access-resolve', adminSession, { method: 'POST', body: JSON.stringify({ ...body, excludeRecordId: record.id }) });
  assertEquals((await current.json()).values['Model.Use'], false);
  assertEquals((await inherited.json()).values['Model.Use'], true);
});

test('effective access reports intrinsic self audit without marking an ACL assignment active', async () => {
  const { adminSession, repo } = await setupAppTest();
  const record = await repo.accessRecords.save({
    principal: { kind: 'user', id: 2 },
    scope: { kind: 'user', userId: 2 },
    sortOrder: 0,
    values: { 'User.Audit': false },
  });
  const response = await request('/access-resolve', adminSession, {
    method: 'POST',
    body: JSON.stringify({ principal: { kind: 'user', id: 2 }, scope: { kind: 'user', userId: 2 } }),
  });
  assertEquals(response.status, 200);
  const resolution = await response.json();
  expect(resolution.values['User.Audit']).toBe(true);
  expect(resolution.decisions.find((row: { recordId: number }) => row.recordId === record.id).permissions['User.Audit']).toBeUndefined();
});

test('group inheritance resolves ancestor scopes and excludes the edited cell', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Operators', 120);
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true, 'Upstream.Edit': 'models' } });
  const edited = await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'upstream', upstreamId: 'up_a' }, sortOrder: 0, values: { 'Model.Use': false } });
  const response = await request('/access-resolve', adminSession, { method: 'POST', body: JSON.stringify({ principal: { kind: 'group', id: group.id }, scope: edited.scope, excludeRecordId: edited.id }) });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.values).toEqual({ 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' });
  expect(result.records).toHaveLength(1);
  expect(result.records[0].scope).toEqual({ kind: 'upstreams' });
});

test('effective results identify personal overrides and never include descendants', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: 2 });
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [2]);
  const assigned = await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'upstream', upstreamId: 'up_a' }, sortOrder: 0, values: { 'Model.Use': true } });
  const personal = await repo.accessRecords.save({ principal: { kind: 'user', id: 2 }, scope: assigned.scope, sortOrder: 0, values: { 'Model.Use': false } });
  await repo.accessRecords.save({ principal: personal.principal, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 0, values: { 'Model.Use': true } });
  const response = await request('/access-resolve', adminSession, { method: 'POST', body: JSON.stringify({ principal: personal.principal, scope: personal.scope }) });
  const result = await response.json();
  expect(result.values['Model.Use']).toBe(false);
  expect(result.records).toHaveLength(2);
  expect(result.decisions.find((row: { recordId: number }) => row.recordId === assigned.id).permissions['Model.Use']).toMatchObject({ kind: 'overridden', by: { id: personal.id } });
});

test('reordering requires admin, a complete model boundary, and a current snapshot', async () => {
  const { adminSession, repo } = await setupAppTest();
  const a = await repo.accessRecords.save({ principal: { kind: 'user', id: 2 }, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt' } }, sortOrder: 0, values: { 'Model.Use': false } });
  const b = await repo.accessRecords.save({ principal: a.principal, scope: { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } }, sortOrder: 1, values: { 'Model.Use': true } });
  const json = { expectedIds: [a.id, b.id], ids: [b.id, a.id] };
  expect((await request('/access-records/reorder', '', { method: 'POST', body: JSON.stringify(json) })).status).toBe(401);
  const response = await request('/access-records/reorder', adminSession, { method: 'POST', body: JSON.stringify(json) });
  expect(response.status).toBe(200);
  expect((await response.json()).records.map((row: { id: number; sortOrder: number }) => [row.id, row.sortOrder]).sort((a: number[], b: number[]) => a[1]! - b[1]!)).toEqual([[b.id, 0], [a.id, 1]]);
  expect((await request('/access-records/reorder', adminSession, { method: 'POST', body: JSON.stringify(json) })).status).toBe(409);
  expect((await request('/access-records/reorder', adminSession, { method: 'POST', body: JSON.stringify({ expectedIds: [a.id, a.id], ids: [a.id, b.id] }) })).status).toBe(400);
});
