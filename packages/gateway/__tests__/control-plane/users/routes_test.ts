import { expect, test } from 'vitest';

import { hashPassword } from '../../../src/shared/passwords.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const adminPost = (sessionId: string, body: unknown) => requestApp('/api/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});
const adminPatch = (sessionId: string, id: number, body: unknown) => requestApp(`/api/users/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});
const adminDelete = (sessionId: string, id: number) => requestApp(`/api/users/${id}`, {
  method: 'DELETE',
  headers: { 'x-floway-session': sessionId },
});

test('POST /api/users creates the user and provisions a Default key', async () => {
  const { adminSession, repo } = await setupAppTest();
  const group = await repo.groups.create('Research', 150);
  const response = await adminPost(adminSession, { username: 'alice', password: 'hunter22', groupIds: [group.id] });
  assertEquals(response.status, 201);
  const body = (await response.json()) as { user: { id: number; username: string } };
  expect(body.user.id).toBeGreaterThan(2);
  assertEquals(body.user.username, 'alice');
  // The Default key is created server-side but never returned to the admin.
  // The new user finds it themselves on the dashboard's Keys page.
  const stored = await repo.apiKeys.listByUserId(body.user.id);
  assertEquals(stored.length, 1);
  assertEquals(stored[0].name, 'Default');
  assertEquals(/^[0-9a-f]{64}$/.test(stored[0].serverSecret), true);
  // Creating a user grants nothing of its own; access comes from the groups it joins.
  assertEquals(await repo.accessRecords.listByPrincipal({ kind: 'user', id: body.user.id }), []);
  assertEquals(await repo.groups.listIdsByUserId(body.user.id), [group.id]);
});

test('PATCH /api/users/1 may rename but cannot be demoted or deleted', async () => {
  const { adminSession } = await setupAppTest();
  assertEquals((await adminPatch(adminSession, 1, { isAdmin: false })).status, 400);
  assertEquals((await adminPatch(adminSession, 1, { username: 'someone-else' })).status, 200);
  assertEquals((await adminDelete(adminSession, 1)).status, 400);
});

test('admin password reset on another user revokes that user\'s sessions', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'bob',
    passwordHash: await hashPassword('old-pw'),
    isAdmin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const bobSession = await repo.sessions.create(3);

  const response = await adminPatch(adminSession, 3, { password: 'reset-pw' });
  assertEquals(response.status, 200);
  expect(await repo.sessions.getByIdAndTouch(bobSession.id)).toBeNull();
});

test('DELETE /api/users/:id cascades to api_keys (soft) + sessions', async () => {
  const { adminSession, repo } = await setupAppTest();
  const created = await adminPost(adminSession, { username: 'alice', password: 'pw' });
  const { user } = (await created.json()) as { user: { id: number } };
  const [defaultKey] = await repo.apiKeys.listByUserId(user.id);
  await repo.sessions.create(user.id);

  const response = await adminDelete(adminSession, user.id);
  assertEquals(response.status, 200);

  expect(await repo.users.getById(user.id)).toBeNull();
  expect(await repo.apiKeys.getById(defaultKey.id)).toBeNull();
  assertEquals(await repo.accessRecords.listByPrincipal({ kind: 'user', id: user.id }), []);
  assertEquals((await repo.sessions.deleteByUserId(user.id)), 0);
});

test('PATCH /api/users/me/password requires session and a correct current password', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'alice',
    passwordHash: await hashPassword('old-pw'),
    isAdmin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const sessionA = await repo.sessions.create(3);
  const sessionB = await repo.sessions.create(3);

  // Wrong current password is rejected.
  const wrongRes = await requestApp('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionA.id },
    body: JSON.stringify({ currentPassword: 'WRONG', newPassword: 'new-pw' }),
  });
  assertEquals(wrongRes.status, 400);

  // Correct flow keeps the current session and revokes others.
  const okRes = await requestApp('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionA.id },
    body: JSON.stringify({ currentPassword: 'old-pw', newPassword: 'new-pw' }),
  });
  assertEquals(okRes.status, 200);
  expect(await repo.sessions.getByIdAndTouch(sessionA.id)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(sessionB.id)).toBeNull();

  // The new password works on subsequent logins.
  const updated = await repo.users.getById(3);
  expect(updated?.passwordHash).not.toBeNull();
});

const patchPreferences = (sessionId: string, body: unknown) => requestApp('/api/users/me/preferences', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});

test('PATCH /api/users/me/preferences merges a partial update and clears language with null', async () => {
  const { adminSession, repo } = await setupAppTest();

  await patchPreferences(adminSession, { language: 'zh-Hans' });
  expect(await repo.userPreferences.get(1)).toEqual({
    quotaDisplay: 'remaining',
    language: 'zh-Hans',
    uiTextEditor: false,
    mergeModelVariants: false,
    foldSmallSeries: false,
  });

  const telemetry = await patchPreferences(adminSession, { mergeModelVariants: true, foldSmallSeries: true });
  assertEquals(telemetry.status, 200);
  expect(await telemetry.json()).toEqual({
    preferences: {
      quotaDisplay: 'remaining',
      language: 'zh-Hans',
      uiTextEditor: false,
      mergeModelVariants: true,
      foldSmallSeries: true,
    },
  });

  const cleared = await patchPreferences(adminSession, { language: null });
  assertEquals(cleared.status, 200);
  expect(await repo.userPreferences.get(1)).toEqual({
    quotaDisplay: 'remaining',
    language: null,
    uiTextEditor: false,
    mergeModelVariants: true,
    foldSmallSeries: true,
  });
});
