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

test('permission reads require Permission.Audit while writes still require admin', async () => {
  const { apiKey, repo } = await setupAppTest();
  const list = await requestApp('/api/access-records', { headers: { 'x-api-key': apiKey.key } });
  const create = await requestApp('/api/access-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify(modelUseRecord(2, 'up_a')),
  });
  assertEquals(list.status, 403);
  assertEquals(create.status, 403);
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'self' },
    sortOrder: 0,
    values: { 'Permission.Audit': true },
  });
  assertEquals((await requestApp('/api/access-records', { headers: { 'x-api-key': apiKey.key } })).status, 200);
});

test('auditing a user makes their membership groups auditable and visible in the principal picker', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'bob', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  await repo.users.save({ id: 4, username: 'hidden-member', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const first = await repo.groups.create('First', 120);
  const second = await repo.groups.create('Second', 180);
  await repo.groups.replaceMembers(first.id, [3, 4]);
  await repo.groups.replaceMembers(second.id, [3]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'user', id: 3 }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: first.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: second.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Upstream.Audit': true } });

  const response = await requestApp('/api/permissions', { headers: { 'x-api-key': apiKey.key } });
  const body = await response.json();
  expect(body.records.map((record: { principal: { kind: string; id: number } }) => `${record.principal.kind}:${record.principal.id}`)).toEqual([
    'user:3', `group:${first.id}`, `group:${second.id}`,
  ]);
  expect(body.directory.users.map((user: { id: number }) => user.id)).toEqual([3]);
  expect(body.directory.groups).toEqual([
    expect.objectContaining({ id: first.id, memberIds: [3] }),
    expect.objectContaining({ id: second.id, memberIds: [3] }),
  ]);
  expect(body.directory.principalUserIds).toEqual([3]);
  expect(body.directory.principalGroupIds).toEqual([first.id, second.id]);

  const effective = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'user', id: 3 }, scope: { kind: 'upstreams' } }),
  });
  expect((await effective.json()).records.map((record: { principal: { kind: string; id: number } }) => `${record.principal.kind}:${record.principal.id}`)).toEqual([
    'user:3', `group:${first.id}`, `group:${second.id}`,
  ]);
});

test('auditing a group exposes that group without its members or their personal rules', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'bob', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Reviewed', 120);
  await repo.groups.replaceMembers(group.id, [3]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'group', groupId: group.id }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  await repo.accessRecords.save({ principal: { kind: 'user', id: 3 }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': false } });

  const body = await (await requestApp('/api/permissions', { headers: { 'x-api-key': apiKey.key } })).json();
  expect(body.records.map((record: { principal: { kind: string; id: number } }) => `${record.principal.kind}:${record.principal.id}`)).toEqual([`group:${group.id}`]);
  expect(body.directory.users).toEqual([]);
  expect(body.directory.groups).toEqual([expect.objectContaining({ id: group.id, memberIds: [] })]);
  expect(body.directory.principalUserIds).toEqual([]);
  expect(body.directory.principalGroupIds).toEqual([group.id]);
});

test('an audited user resolves their own effective user scope with membership-group sources', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'audited', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Shared', 120);
  await repo.groups.replaceMembers(group.id, [3]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'User.Audit': true } });

  const response = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'user', id: 3 }, scope: { kind: 'user', userId: 3 } }),
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  expect(body.values['User.Audit']).toBe(true);
  expect(body.records.map((record: { principal: { kind: string } }) => record.principal.kind)).toEqual(['group']);
});

test('an audited user can see membership-group identities without gaining unrelated users', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'audited', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  await repo.users.save({ id: 4, username: 'source-target', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Shared', 120);
  await repo.groups.replaceMembers(group.id, [3, 4]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId: 4 }, sortOrder: 0, values: { 'User.Audit': true } });

  const body = await (await requestApp('/api/permissions', { headers: { 'x-api-key': apiKey.key } })).json();
  expect(body.records.map((record: { principal: { kind: string; id: number } }) => `${record.principal.kind}:${record.principal.id}`)).toEqual([`group:${group.id}`]);
  expect(body.directory.users.map((user: { id: number }) => user.id)).toEqual([3, 4]);
  expect(body.directory.principalUserIds).toEqual([3]);
  expect(body.directory.principalGroupIds).toEqual([group.id]);
  expect(body.directory.groups).toEqual([expect.objectContaining({ id: group.id, memberIds: [3] })]);
});

test('resolving another user\'s scope does not expand that user\'s membership groups', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'audited', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  await repo.users.save({ id: 4, username: 'other', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Shared', 120);
  await repo.groups.replaceMembers(group.id, [3, 4]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId: 4 }, sortOrder: 0, values: { 'User.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'group', groupId: group.id }, sortOrder: 0, values: { 'User.Audit': true } });

  const response = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'user', id: 3 }, scope: { kind: 'user', userId: 4 } }),
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  expect(body.records.map((record: { scope: { kind: string } }) => record.scope.kind)).toEqual(['user']);
  expect(body.values['User.Audit']).toBe(true);
});

test('a group auditor cannot probe membership through its own /Groups rule', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'member', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  await repo.users.save({ id: 4, username: 'outsider', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Audited', 120);
  await repo.groups.replaceMembers(group.id, [3]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'group', groupId: group.id }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'group', groupId: group.id }, sortOrder: 0, values: { 'User.Audit': true } });

  const resolve = (userId: number) => requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId } }),
  });
  const member = await (await resolve(3)).json();
  const outsider = await (await resolve(4)).json();
  expect(member.values['User.Audit']).toBe(false);
  expect(outsider.values['User.Audit']).toBe(false);
  expect(member.records).toEqual([]);
  expect(outsider.records).toEqual([]);
});

test('a group auditor still sees direct user-target rules on a user scope', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'member', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Audited', 120);
  await repo.groups.replaceMembers(group.id, [3]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'group', groupId: group.id }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'User.Audit': true } });

  const response = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'group', id: group.id }, scope: { kind: 'user', userId: 3 } }),
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  expect(body.records.map((record: { scope: { kind: string } }) => record.scope.kind)).toEqual(['user']);
  expect(body.values['User.Audit']).toBe(true);
});

test('Self rules are included when resolving the user\'s own user scope', async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  const resolveSelf = async () => (await (await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: apiKey.userId } }),
  })).json());

  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'users' }, sortOrder: 0, values: { 'Permission.Audit': true } });
  expect((await resolveSelf()).values['Permission.Audit']).toBe(true);

  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: apiKey.userId }, sortOrder: 1, values: { 'Permission.Audit': false } });
  expect((await resolveSelf()).values['Permission.Audit']).toBe(false);

  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'self' }, sortOrder: 2, values: { 'Permission.Audit': true } });
  expect((await resolveSelf()).values['Permission.Audit']).toBe(true);
});

test('Self is a rule scope and cannot be used as a resolve target', async () => {
  const { adminSession } = await setupAppTest();
  const response = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ principal: { kind: 'user', id: 2 }, scope: { kind: 'self' } }),
  });
  assertEquals(response.status, 400);
});

test('resolving another user\'s scope does not reveal membership groups', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'audited', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  await repo.users.save({ id: 4, username: 'other', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Shared', 120);
  await repo.groups.replaceMembers(group.id, [3, 4]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'Permission.Audit': true } });
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'group', groupId: group.id }, sortOrder: 0, values: { 'User.Audit': true } });

  const response = await requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal: { kind: 'user', id: 3 }, scope: { kind: 'user', userId: 4 } }),
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  expect(body.records).toEqual([]);
  expect(body.values['User.Audit']).toBe(false);
});

test('admin permission data returns each group rule once', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Admins Only', 120);
  const record = await repo.accessRecords.save({
    principal: { kind: 'group', id: group.id },
    scope: { kind: 'upstreams' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });

  const body = await (await requestApp('/api/permissions', { headers: { 'x-floway-session': adminSession } })).json();
  expect(body.records.filter((candidate: { id: number }) => candidate.id === record.id)).toHaveLength(1);
});

test('admin permission data includes every upstream even without ACL references', async () => {
  const { adminSession, copilotUpstream, repo } = await setupAppTest();
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: 2 });
  const body = await (await requestApp('/api/permissions', { headers: { 'x-floway-session': adminSession } })).json();
  expect(body.records).toEqual([]);
  expect(body.upstreams.map((upstream: { id: string }) => upstream.id)).toEqual([copilotUpstream.id]);
});

test('non-admin access resolve accepts only projected user and group principals', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.users.save({ id: 3, username: 'bob', passwordHash: null, isAdmin: false, createdAt: '', deletedAt: null });
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [3]);
  await repo.accessRecords.save({ principal: { kind: 'user', id: apiKey.userId }, scope: { kind: 'user', userId: 3 }, sortOrder: 0, values: { 'Permission.Audit': true } });
  const call = (principal: { kind: 'user' | 'group'; id: number }) => requestApp('/api/access-resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ principal, scope: { kind: 'upstreams' } }),
  });
  assertEquals((await call({ kind: 'user', id: 3 })).status, 200);
  assertEquals((await call({ kind: 'group', id: group.id })).status, 200);
  assertEquals((await call({ kind: 'user', id: apiKey.userId })).status, 404);
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

  const validSelf = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify({ principal: { kind: 'user', id: 2 }, scope: { kind: 'self' }, sortOrder: 0, values: { 'Permission.Audit': true } }),
  });
  assertEquals(validSelf.status, 201);
  const invalidSelf = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify({ principal: { kind: 'user', id: 2 }, scope: { kind: 'self' }, sortOrder: 0, values: { 'User.Audit': true } }),
  });
  assertEquals(invalidSelf.status, 400);
  const invalidGroupsUserAudit = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify({ principal: { kind: 'user', id: 2 }, scope: { kind: 'groups' }, sortOrder: 0, values: { 'User.Audit': true } }),
  });
  assertEquals(invalidGroupsUserAudit.status, 400);
  const group = await (await request('/groups', adminSession, { method: 'POST', body: JSON.stringify({ name: 'Self Group', hue: 100, memberIds: [] }) })).json();
  const groupSelf = await request('/access-records', adminSession, {
    method: 'POST',
    body: JSON.stringify({ principal: { kind: 'group', id: group.id }, scope: { kind: 'self' }, sortOrder: 0, values: { 'Permission.Audit': true } }),
  });
  assertEquals(groupSelf.status, 201);

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
