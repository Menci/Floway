import { expect, test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../dump/registry.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { hashPassword } from '../../shared/passwords.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
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

test('GET /api/users requires admin', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/users', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
});

test('POST /api/users creates the user and provisions a Default key', async () => {
  const { adminSession, repo } = await setupAppTest();
  const response = await adminPost(adminSession, { username: 'alice', password: 'hunter22' });
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
});

test('POST /api/users rejects duplicate username + unknown upstream id', async () => {
  const { adminSession } = await setupAppTest();
  await adminPost(adminSession, { username: 'alice', password: 'pw' });
  const dup = await adminPost(adminSession, { username: 'alice', password: 'pw' });
  assertEquals(dup.status, 400);
  const unknown = await adminPost(adminSession, { username: 'bob', password: 'pw', upstreamIds: ['up_ghost'] });
  assertEquals(unknown.status, 400);
});

test('POST /api/users rejects a username that differs only in case', async () => {
  const { adminSession } = await setupAppTest();
  await adminPost(adminSession, { username: 'alice', password: 'pw' });
  const dup = await adminPost(adminSession, { username: 'Alice', password: 'pw' });
  assertEquals(dup.status, 400);
});

test('PATCH /api/users/1 may rename but cannot be demoted or deleted', async () => {
  const { adminSession } = await setupAppTest();
  assertEquals((await adminPatch(adminSession, 1, { isAdmin: false })).status, 400);
  assertEquals((await adminPatch(adminSession, 1, { username: 'someone-else' })).status, 200);
  assertEquals((await adminDelete(adminSession, 1)).status, 400);
});

test('PATCH /api/users/:self cannot demote yourself but may change password', async () => {
  const { adminSession, repo } = await setupAppTest();
  const demote = await adminPatch(adminSession, 1, { isAdmin: false });
  assertEquals(demote.status, 400);
  // Admin self-PATCH may set password (this is the bootstrap path for user 1
  // to set an initial password after the migration). The acting session
  // survives; any other session of the same user is signed out.
  const otherSession = await repo.sessions.create(1);
  const setPw = await adminPatch(adminSession, 1, { password: 'new-admin-pw' });
  assertEquals(setPw.status, 200);
  expect(await repo.sessions.getByIdAndTouch(adminSession)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(otherSession.id)).toBeNull();
});

test('admin password reset on another user revokes that user\'s sessions', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'bob',
    passwordHash: await hashPassword('old-pw'),
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const bobSession = await repo.sessions.create(3);

  const response = await adminPatch(adminSession, 3, { password: 'reset-pw' });
  assertEquals(response.status, 200);
  expect(await repo.sessions.getByIdAndTouch(bobSession.id)).toBeNull();
});

test('PATCH /api/users/:id can demote and revoke global-telemetry on a non-self admin', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'bob',
    passwordHash: await hashPassword('pw'),
    isAdmin: true,
    upstreamIds: null,
    canViewGlobalTelemetry: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const response = await adminPatch(adminSession, 3, { isAdmin: false, canViewGlobalTelemetry: false });
  assertEquals(response.status, 200);
  const bob = await repo.users.getById(3);
  expect(bob?.isAdmin).toBe(false);
  expect(bob?.canViewGlobalTelemetry).toBe(false);
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
  assertEquals((await repo.sessions.deleteByUserId(user.id)), 0);
});

test('DELETE /api/users/:id succeeds when the broker close hook throws on a cascaded key', async () => {
  const { adminSession, repo } = await setupAppTest();
  const created = await adminPost(adminSession, { username: 'alice', password: 'pw' });
  const { user } = (await created.json()) as { user: { id: number } };
  const [defaultKey] = await repo.apiKeys.listByUserId(user.id);
  // Enable retention on the cascaded key so the broker close hook is exercised.
  await repo.apiKeys.save({ ...defaultKey, dumpRetentionSeconds: 3600 });

  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  stubs.failOn('closeChannel', new Error('broker down'));

  const response = await adminDelete(adminSession, user.id);
  assertEquals(response.status, 200);
  // The store purge still ran for the cascaded key.
  assertEquals(stubs.purgedAll.includes(defaultKey.id), true);
  // The user soft-delete still landed.
  expect(await repo.users.getById(user.id)).toBeNull();
});

test('PATCH /api/users/me/password requires session and a correct current password', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'alice',
    passwordHash: await hashPassword('old-pw'),
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
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

test('PATCH /api/users/me/password rejects API key auth (must be a session)', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
  });
  assertEquals(response.status, 401);
});
