import { expect, test, vi } from 'vitest';

import { DUMP_DISABLED_REASON } from '../../../src/dump/broker.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import type { ApiKey, User } from '../../../src/repo/types.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import { requestControlPlane, setupControlPlaneTest, TEST_PASSWORD, TEST_PASSWORD_HASH } from '../../test-utils/control-plane.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';
import type { UpstreamRecord } from '@floway-dev/provider';

type TestRepo = Awaited<ReturnType<typeof setupControlPlaneTest>>['repo'];

const adminPost = (sessionId: string, body: unknown) => requestControlPlane('/api/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});
const adminPatch = (sessionId: string, id: string | number, body: unknown) => requestControlPlane(`/api/users/${id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-floway-session': sessionId },
  body: JSON.stringify(body),
});
const adminDelete = (sessionId: string, id: string | number) => requestControlPlane(`/api/users/${id}`, {
  method: 'DELETE',
  headers: { 'x-floway-session': sessionId },
});
const login = (username: string, password: string) => requestControlPlane('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

const sampleUser = (overrides: Partial<User> = {}): User => ({
  id: 3,
  username: 'alice',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

const sampleKey = (userId: number, id: string, secretByte: string): ApiKey => ({
  id,
  userId,
  name: id,
  key: `raw_${id}`,
  serverSecret: secretByte.repeat(64),
  createdAt: `2026-01-01T00:00:0${id.endsWith('2') ? '2' : '1'}.000Z`,
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  responsesRetentionSeconds: 0,
});

const customUpstream = (): UpstreamRecord => ({
  id: 'up_x',
  kind: 'custom',
  name: 'X',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    ingressHeadersRules: [],
    apiKey: 'key',
    endpoints: { chatCompletions: {} },
  },
});

test('GET /api/users requires admin privileges', async () => {
  const { apiKey } = await setupControlPlaneTest();
  const response = await requestControlPlane('/api/users', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: 'Admin privileges required' });
});

test('concurrent duplicate POST /api/users creates one complete account and returns one validation error', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.upstreams.save(customUpstream());
  const request = () => adminPost(adminSession, {
    username: 'alice',
    password: 'pw',
    isAdmin: true,
    upstreamIds: ['up_x'],
  });

  const responses = await Promise.all([request(), request()]);
  assertEquals(responses.map(response => response.status).toSorted(), [201, 400]);
  const users = (await repo.users.list()).filter(user => user.username === 'alice');
  assertEquals(users.length, 1);
  assertEquals(users[0].isAdmin, true);
  assertEquals(users[0].upstreamIds, ['up_x']);
  const keys = await repo.apiKeys.listByUserId(users[0].id);
  assertEquals(keys.length, 1);
  assertEquals(keys[0].name, 'Default');

  const winner = responses.find(response => response.status === 201)!;
  const body = await winner.json() as { user: Record<string, unknown> };
  assertEquals(body.user, {
    id: users[0].id,
    username: 'alice',
    isAdmin: true,
    upstreamIds: ['up_x'],
    createdAt: users[0].createdAt,
  });
  assertEquals(Object.keys(body), ['user']);
});

test('POST /api/users rejects exact and case-folded duplicates without hashing another password', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());

  for (const username of ['alice', 'Alice']) {
    const response = await adminPost(adminSession, { username, password: 'pw' });
    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: 'That username is already taken (usernames are case-insensitive).' });
  }
});

test('user create and update reject unknown upstream caps and accept a live cap', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());
  await repo.upstreams.save(customUpstream());

  const badCreate = await adminPost(adminSession, { username: 'bob', password: 'pw', upstreamIds: ['up_ghost'] });
  assertEquals(badCreate.status, 400);
  const badUpdate = await adminPatch(adminSession, 3, { upstreamIds: ['up_ghost'] });
  assertEquals(badUpdate.status, 400);
  const updated = await adminPatch(adminSession, 3, { upstreamIds: ['up_x'] });
  assertEquals(updated.status, 200);
  assertEquals((await repo.users.getById(3))?.upstreamIds, ['up_x']);
});

test('PATCH and DELETE reject noncanonical or unsafe user ids without touching user 1', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  for (const id of ['01', '+1', '1e0', '1.0', '0', '9007199254740992']) {
    assertEquals((await adminPatch(adminSession, id, { username: 'changed' })).status, 400);
    assertEquals((await adminDelete(adminSession, id)).status, 400);
  }
  assertEquals((await adminPatch(adminSession, Number.MAX_SAFE_INTEGER, { username: 'changed' })).status, 404);
  assertEquals((await repo.users.getById(1))?.username, 'admin');
});

test('user 1 may be renamed and reset but cannot be demoted or deleted', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  assertEquals((await adminPatch(adminSession, 1, { isAdmin: false })).status, 400);
  assertEquals((await adminPatch(adminSession, 1, { username: 'primary-admin' })).status, 200);
  assertEquals((await adminDelete(adminSession, 1)).status, 400);

  const otherSession = await repo.sessions.create(1);
  assertEquals((await adminPatch(adminSession, 1, { password: 'new-admin-pw' })).status, 200);
  expect(await repo.sessions.getByIdAndTouch(adminSession)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(otherSession.id)).toBeNull();
});

test('a non-seed admin cannot demote or delete itself', async () => {
  const { repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser({ isAdmin: true }));
  const session = await repo.sessions.create(3);

  const demote = await adminPatch(session.id, 3, { isAdmin: false });
  assertEquals(demote.status, 400);
  assertEquals(await demote.json(), { error: 'cannot demote yourself' });
  const deletion = await adminDelete(session.id, 3);
  assertEquals(deletion.status, 400);
  assertEquals(await deletion.json(), { error: 'cannot delete yourself' });
  assertEquals((await repo.users.getById(3))?.isAdmin, true);
});

test('admin password reset revokes the target sessions and installs a usable password', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser({ username: 'bob' }));
  const sessionA = await repo.sessions.create(3);
  const sessionB = await repo.sessions.create(3);

  const response = await adminPatch(adminSession, 3, { password: 'reset-pw' });
  assertEquals(response.status, 200);
  expect(await repo.sessions.getByIdAndTouch(sessionA.id)).toBeNull();
  expect(await repo.sessions.getByIdAndTouch(sessionB.id)).toBeNull();
  assertEquals((await login('bob', 'reset-pw')).status, 200);
});

test('concurrent disjoint user patches preserve both updates', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());

  const responses = await Promise.all([
    adminPatch(adminSession, 3, { username: 'renamed' }),
    adminPatch(adminSession, 3, { isAdmin: true }),
  ]);
  assertEquals(responses.map(response => response.status), [200, 200]);
  const user = await repo.users.getById(3);
  assertExists(user);
  assertEquals(user.username, 'renamed');
  assertEquals(user.isAdmin, true);
});

test('a user update that loses a race with deletion cannot resurrect the account', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());
  const originalUpdate = repo.users.updateActive.bind(repo.users);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reachedUpdate = new Promise<void>(resolve => { entered = resolve; });
  repo.users.updateActive = async (...args) => {
    entered();
    await gate;
    return await originalUpdate(...args);
  };

  const patch = adminPatch(adminSession, 3, { username: 'renamed' });
  await reachedUpdate;
  const deletion = await adminDelete(adminSession, 3);
  release();
  const update = await patch;

  assertEquals(deletion.status, 200);
  assertEquals(update.status, 404);
  expect(await repo.users.getById(3)).toBeNull();
});

test('DELETE /api/users/:id rolls back the whole cascade when retention scheduling fails', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());
  const key = sampleKey(3, 'key_1', '1');
  await repo.apiKeys.save(key);
  const session = await repo.sessions.create(3);
  repo.expirationSweeps.schedule = () => Promise.reject(new Error('scheduler unavailable'));
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await adminDelete(adminSession, 3);
    assertEquals(response.status, 500);
  } finally {
    consoleSpy.mockRestore();
  }
  expect(await repo.users.getById(3)).not.toBeNull();
  expect(await repo.apiKeys.getById(key.id)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(session.id)).not.toBeNull();
});

test('self-service password change validates the old password, revokes other sessions, and installs the new password', async () => {
  const { repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser({ passwordHash: TEST_PASSWORD_HASH }));
  const sessionA = await repo.sessions.create(3);
  const sessionB = await repo.sessions.create(3);

  const wrong = await requestControlPlane('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionA.id },
    body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new-pw' }),
  });
  assertEquals(wrong.status, 400);
  assertEquals(await wrong.json(), { error: 'Current password is incorrect' });

  const changed = await requestControlPlane('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': sessionA.id },
    body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'new-pw' }),
  });
  assertEquals(changed.status, 200);
  expect(await repo.sessions.getByIdAndTouch(sessionA.id)).not.toBeNull();
  expect(await repo.sessions.getByIdAndTouch(sessionB.id)).toBeNull();
  assertEquals((await login('alice', TEST_PASSWORD)).status, 401);
  assertEquals((await login('alice', 'new-pw')).status, 200);
});

test('self-service password change rejects API-key auth and an account without a password', async () => {
  const { apiKey, repo } = await setupControlPlaneTest();
  const apiKeyResponse = await requestControlPlane('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
  });
  assertEquals(apiKeyResponse.status, 401);

  await repo.users.save(sampleUser());
  const session = await repo.sessions.create(3);
  const noPassword = await requestControlPlane('/api/users/me/password', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': session.id },
    body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
  });
  assertEquals(noPassword.status, 400);
  assertEquals(await noPassword.json(), { error: 'This account has no password set; ask an admin to reset it.' });
});

test('GET /api/users and /auth/me prune deleted upstream ids without exposing stored credentials', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.upstreams.save(customUpstream());
  const admin = await repo.users.getById(1);
  assertExists(admin);
  await repo.users.save({ ...admin, upstreamIds: ['up_gone', 'up_x'] });

  const list = await requestControlPlane('/api/users', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const users = await list.json() as Array<Record<string, unknown>>;
  assertEquals(users.find(user => user.id === 1), {
    id: 1,
    username: 'admin',
    isAdmin: true,
    upstreamIds: ['up_x'],
    createdAt: admin.createdAt,
  });

  const me = await requestControlPlane('/auth/me', { headers: { 'x-floway-session': adminSession } });
  assertEquals((await me.json() as { user: unknown }).user, { id: 1, username: 'admin', isAdmin: true, upstreamIds: ['up_x'] });
});

test('DELETE /api/users/:id attempts every broker close and keeps the committed cascade when the broker fails', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());
  const keys = [sampleKey(3, 'key_1', '1'), sampleKey(3, 'key_2', '2')];
  for (const key of keys) await repo.apiKeys.save(key);
  const session = await repo.sessions.create(3);
  const stubs = installDumpStubs(initDumpStore, initDumpBroker);
  const brokerError = new Error('broker down');
  stubs.failOn('closeChannel', brokerError);
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await adminDelete(adminSession, 3);
    assertEquals(response.status, 200);
    await flushBackground();
    assertEquals(stubs.closeChannelAttempts, keys.map(key => ({ keyId: key.id, reason: DUMP_DISABLED_REASON })));
    assertEquals(consoleSpy.mock.calls.length, keys.length);
  } finally {
    consoleSpy.mockRestore();
  }
  expect(await repo.users.getById(3)).toBeNull();
  for (const key of keys) expect(await repo.apiKeys.getById(key.id)).toBeNull();
  expect(await repo.sessions.getByIdAndTouch(session.id)).toBeNull();
});

test('DELETE /api/users/:id responds after atomic revocation without waiting once per key on a hung broker', async () => {
  const { adminSession, repo } = await setupControlPlaneTest();
  await repo.users.save(sampleUser());
  const keys = [sampleKey(3, 'key_1', '1'), sampleKey(3, 'key_2', '2')];
  for (const key of keys) await repo.apiKeys.save(key);
  const attempts: string[] = [];
  let release!: () => void;
  const brokerGate = new Promise<void>(resolve => { release = resolve; });
  initDumpBroker({
    async publish() {},
    async closeChannel(keyId) {
      attempts.push(keyId);
      await brokerGate;
    },
    subscribe: () => (async function*() {})(),
  });

  const response = await adminDelete(adminSession, 3);
  assertEquals(response.status, 200);
  assertEquals(attempts, ['key_1']);
  expect(await repo.users.getById(3)).toBeNull();

  release();
  await flushBackground();
  assertEquals(attempts, ['key_1', 'key_2']);
});
