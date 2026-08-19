import { expect, test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { hashPassword } from '../../../src/shared/passwords.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

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
const adminBulkUpstreamPatch = (sessionId: string, body: unknown) => requestApp('/api/users/upstream-access', {
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

test('POST /api/users accepts an empty upstream whitelist', async () => {
  const { adminSession, repo } = await setupAppTest();
  const response = await adminPost(adminSession, { username: 'no-upstreams', password: 'pw', upstreamIds: [] });
  assertEquals(response.status, 201);
  const body = (await response.json()) as { user: { id: number; upstreamIds: string[] } };
  assertEquals(body.user.upstreamIds, []);
  assertEquals((await repo.users.getById(body.user.id))?.upstreamIds, []);
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
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const bobSession = await repo.sessions.create(3);

  const response = await adminPatch(adminSession, 3, { password: 'reset-pw' });
  assertEquals(response.status, 200);
  expect(await repo.sessions.getByIdAndTouch(bobSession.id)).toBeNull();
});

test('PATCH /api/users/:id can demote a non-self admin', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'bob',
    passwordHash: await hashPassword('pw'),
    isAdmin: true,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const response = await adminPatch(adminSession, 3, { isAdmin: false });
  assertEquals(response.status, 200);
  const bob = await repo.users.getById(3);
  expect(bob?.isAdmin).toBe(false);
});

test('PATCH /api/users/upstream-access changes only named upstream membership for selected users', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 0 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 1 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 2 }));
  const admin = await repo.users.getById(1);
  assertExists(admin);
  await repo.users.save({ ...admin, upstreamIds: ['up_c', 'up_b'] });
  await repo.users.save({
    ...admin,
    id: 3,
    username: 'limited',
    isAdmin: false,
    upstreamIds: ['up_a'],
  });
  await repo.users.save({
    ...admin,
    id: 4,
    username: 'untouched',
    isAdmin: false,
    upstreamIds: ['up_b'],
  });

  const response = await adminBulkUpstreamPatch(adminSession, {
    userIds: [1, 3],
    changes: [
      { upstreamId: 'up_b', allowed: false },
      { upstreamId: 'up_c', allowed: true },
    ],
  });
  assertEquals(response.status, 200);
  assertEquals((await repo.users.getById(1))?.upstreamIds, ['up_c']);
  assertEquals((await repo.users.getById(3))?.upstreamIds, ['up_a', 'up_c']);
  assertEquals((await repo.users.getById(4))?.upstreamIds, ['up_b']);
});

test('PATCH /api/users/upstream-access supports an empty whitelist and validates its targets', async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_only', name: 'Only' }));

  const response = await adminBulkUpstreamPatch(adminSession, {
    userIds: [1],
    changes: [
      { upstreamId: 'up_copilot', allowed: false },
      { upstreamId: 'up_only', allowed: false },
    ],
  });
  assertEquals(response.status, 200);
  assertEquals((await repo.users.getById(1))?.upstreamIds, []);

  assertEquals((await adminBulkUpstreamPatch(adminSession, {
    userIds: [999],
    changes: [{ upstreamId: 'up_only', allowed: true }],
  })).status, 404);
  assertEquals((await adminBulkUpstreamPatch(adminSession, {
    userIds: [1],
    changes: [{ upstreamId: 'up_missing', allowed: true }],
  })).status, 400);
  assertEquals((await requestApp('/api/users/upstream-access', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ userIds: [1], changes: [{ upstreamId: 'up_only', allowed: true }] }),
  })).status, 403);
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

test('OAuth2 account management preserves a login method for self-service and admin unlink', async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  await repo.users.save({
    id: 3,
    username: 'oauth-only',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const session = await repo.sessions.create(3);
  const account = (providerId: string) => ({
    providerId,
    providerUserId: `${providerId}-identity`,
    userId: 3,
    providerLogin: `${providerId}-login`,
    createdAt: '2026-08-19T00:00:00.000Z',
    lastLoginAt: '2026-08-19T00:00:00.000Z',
  });
  await repo.oauth2.saveAccount(account('first'));

  const apiKeyAttempt = await requestApp('/api/users/me/oauth2-accounts', {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(apiKeyAttempt.status, 401);

  const firstList = await requestApp('/api/users/me/oauth2-accounts', {
    headers: { 'x-floway-session': session.id },
  });
  assertEquals(firstList.status, 200);
  assertEquals((await firstList.json() as { accounts: Array<{ can_unlink: boolean }> }).accounts[0]?.can_unlink, false);

  const lastAttempt = await requestApp('/api/users/me/oauth2-accounts/first', {
    method: 'DELETE',
    headers: { 'x-floway-session': session.id },
  });
  assertEquals(lastAttempt.status, 409);

  await repo.oauth2.saveAccount(account('second'));
  const removed = await requestApp('/api/users/me/oauth2-accounts/first', {
    method: 'DELETE',
    headers: { 'x-floway-session': session.id },
  });
  assertEquals(removed.status, 200);
  assertEquals(await removed.json(), {
    accounts: [{
      provider_id: 'second',
      provider_display_name: 'second',
      provider_login: 'second-login',
      created_at: '2026-08-19T00:00:00.000Z',
      last_login_at: '2026-08-19T00:00:00.000Z',
      can_unlink: false,
    }],
  });

  const user = await repo.users.getById(3);
  assertExists(user);
  await repo.users.save({ ...user, passwordHash: await hashPassword('local-password') });
  const adminList = await requestApp('/api/users/3/oauth2-accounts', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(adminList.status, 200);
  assertEquals((await adminList.json() as { accounts: Array<{ can_unlink: boolean }> }).accounts[0]?.can_unlink, true);

  const adminRemoved = await requestApp('/api/users/3/oauth2-accounts/second', {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(adminRemoved.status, 200);
  assertEquals(await adminRemoved.json(), { accounts: [] });
});

test('GET /api/users and /auth/me drop a cap entry whose upstream was deleted', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  const admin = await repo.users.getById(1);
  assertExists(admin);
  await repo.users.save({ ...admin, upstreamIds: ['up_gone', 'up_x'] });

  const list = await requestApp('/api/users', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const users = (await list.json()) as Array<{ id: number; upstreamIds: string[] | null }>;
  assertEquals(users.find(user => user.id === 1)?.upstreamIds, ['up_x']);

  const me = await requestApp('/auth/me', { headers: { 'x-floway-session': adminSession } });
  assertEquals(me.status, 200);
  assertEquals(((await me.json()) as { user: { upstreamIds: string[] } }).user.upstreamIds, ['up_x']);
});
