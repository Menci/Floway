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

test('groups create, update, and project membership onto the user list', async () => {
  const { adminSession } = await setupAppTest();
  const created = await request('/groups', adminSession, {
    method: 'POST',
    body: JSON.stringify({ name: 'Operators', memberIds: [2] }),
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
    body: JSON.stringify({ name: 'Operators', memberIds: [999] }),
  });
  assertEquals(response.status, 400);
});

test('deleting a group clears memberships', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Operators');
  await repo.groups.replaceMembers(group.id, [2]);
  const response = await request(`/groups/${group.id}`, adminSession, { method: 'DELETE' });
  assertEquals(response.status, 200);
  assertEquals(await repo.groups.listIdsByUserId(2), []);
});
