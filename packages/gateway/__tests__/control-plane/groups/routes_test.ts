import { expect, test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const request = (path: string, session: string, init: RequestInit = {}) => requestApp(`/api${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', 'x-floway-session': session, ...init.headers },
});

test('group management routes require admin', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/groups', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
});

test('user directory sends entities and membership records once in one repository snapshot', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [2]);
  repo.users.list = () => { throw new Error('directory must not assemble separate repository reads'); };
  repo.groups.list = () => { throw new Error('directory must not assemble separate repository reads'); };
  const response = await request('/user-directory', adminSession);
  expect(response.status).toBe(200);
  const body = await response.json() as { users: Array<{ id: number; passwordHash?: string }>; groups: Array<{ id: number }>; memberships: Array<{ groupId: number; userId: number; createdAt: string }>; principalUserIds: number[]; principalGroupIds: number[] };
  expect(body.groups).toEqual([group]);
  expect(body.memberships).toEqual([{ groupId: group.id, userId: 2, createdAt: expect.any(String) }]);
  expect(body.users.every(user => !Object.hasOwn(user, 'groupIds'))).toBe(true);
  expect(body.groups.every(group => !Object.hasOwn(group, 'memberIds'))).toBe(true);
  expect(body.users.every(user => !Object.hasOwn(user, 'passwordHash'))).toBe(true);
});

test('groups create, update, and project membership onto the user list', async () => {
  const { adminSession } = await setupAppTest();
  const created = await request('/groups', adminSession, {
    method: 'POST',
    body: JSON.stringify({ name: 'Operators', hue: 120, memberIds: [2] }),
  });
  assertEquals(created.status, 201);
  const group = (await created.json()) as { id: number; name: string; memberIds: number[] };
  assertEquals(group.name, 'Operators');
  assertEquals(group.memberIds, [2]);

  const users = await request('/users', adminSession);
  const user = ((await users.json()) as Array<{ id: number; groupIds: number[] }>).find(candidate => candidate.id === 2);
  assertEquals(user?.groupIds, [group.id]);

  const updated = await request(`/groups/${group.id}`, adminSession, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Platform', memberIds: [] }),
  });
  assertEquals(updated.status, 200);
  expect(await updated.json()).toMatchObject({ name: 'Platform', memberIds: [] });
});

test('group membership rejects unknown users', async () => {
  const { adminSession } = await setupAppTest();
  const response = await request('/groups', adminSession, {
    method: 'POST',
    body: JSON.stringify({ name: 'Operators', hue: 120, memberIds: [999] }),
  });
  assertEquals(response.status, 400);
});

test('deleting a group clears memberships', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Operators', 120);
  await repo.groups.replaceMembers(group.id, [2]);
  await repo.accessRecords.save({ principal: { kind: 'group', id: group.id }, scope: { kind: 'upstreams' }, sortOrder: 0, values: { 'Model.Use': true } });
  const response = await request(`/groups/${group.id}`, adminSession, { method: 'DELETE' });
  assertEquals(response.status, 200);
  assertEquals(await repo.groups.listIdsByUserId(2), []);
  assertEquals(await repo.accessRecords.listByPrincipal({ kind: 'group', id: group.id }), []);
});

test('updates color without changing membership and rejects invalid hue angles', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Platform', 250);
  await repo.groups.replaceMembers(group.id, [2]);
  const response = await request(`/groups/${group.id}`, adminSession, { method: 'PATCH', body: JSON.stringify({ hue: 150 }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ hue: 150, memberIds: [2] });
  for (const hue of [-1, 360, 12.5]) {
    expect((await request('/groups', adminSession, { method: 'POST', body: JSON.stringify({ name: 'Invalid', hue }) })).status).toBe(400);
  }
});

test('member operations are idempotent and reject missing records', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Platform', 250);
  const path = `/groups/${group.id}/members/2`;
  expect((await request(path, adminSession, { method: 'PUT' })).status).toBe(200);
  expect((await request(path, adminSession, { method: 'PUT' })).status).toBe(200);
  expect(await repo.groups.listMemberIds(group.id)).toEqual([2]);
  expect((await request(`/groups/${group.id}/members/999`, adminSession, { method: 'PUT' })).status).toBe(404);
  expect((await request('/groups/999/members/2', adminSession, { method: 'DELETE' })).status).toBe(404);
  expect((await request(path, adminSession, { method: 'DELETE' })).status).toBe(200);
  expect((await request(path, adminSession, { method: 'DELETE' })).status).toBe(200);
  expect(await repo.groups.listMemberIds(group.id)).toEqual([]);
});

test('user edits replace group selection and validate before changing the user', async () => {
  const { adminSession, repo } = await setupAppTest();
  const first = await repo.groups.create('Platform', 250);
  const second = await repo.groups.create('Research', 150);
  const patch = (body: unknown) => request('/users/2', adminSession, { method: 'PATCH', body: JSON.stringify(body) });
  expect((await patch({ groupIds: [first.id, second.id] })).status).toBe(200);
  expect(await repo.groups.listIdsByUserId(2)).toEqual([first.id, second.id]);
  expect((await patch({ groupIds: [second.id] })).status).toBe(200);
  expect(await repo.groups.listMemberIds(first.id)).toEqual([]);
  const before = await repo.users.getById(2);
  expect((await patch({ username: 'unexpected', groupIds: [999] })).status).toBe(400);
  expect(await repo.users.getById(2)).toEqual(before);
  expect(await repo.groups.listIdsByUserId(2)).toEqual([second.id]);
  expect((await patch({ groupIds: [] })).status).toBe(200);
  expect(await repo.groups.listMemberIds(second.id)).toEqual([]);
});

test('new users can join groups and deleted users disappear from the roster', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Platform', 250);
  const response = await request('/users', adminSession, { method: 'POST', body: JSON.stringify({ username: 'new.member', password: 'password', groupIds: [group.id] }) });
  expect(response.status).toBe(201);
  const { user } = await response.json() as { user: { id: number; groupIds: number[] } };
  expect(user.groupIds).toEqual([group.id]);
  expect(await repo.groups.listMemberIds(group.id)).toEqual([user.id]);
  expect((await request(`/users/${user.id}`, adminSession, { method: 'DELETE' })).status).toBe(200);
  expect(await repo.groups.listMemberIds(group.id)).toEqual([]);
});
