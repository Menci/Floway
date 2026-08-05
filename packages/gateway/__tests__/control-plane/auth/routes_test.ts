import { afterEach, expect, test, vi } from 'vitest';

import { requestControlPlane, setupControlPlaneTest, TEST_PASSWORD, TEST_PASSWORD_HASH } from '../../test-utils/control-plane.ts';
import { initRuntimeKind, initTimingSafeEqual } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const login = (username: string, password: string) => requestControlPlane('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

afterEach(() => {
  initRuntimeKind('node');
  initTimingSafeEqual((a, b) => a.every((byte, index) => byte === b[index]));
  vi.unstubAllEnvs();
});

test('/auth/login authenticates ADMIN_KEY without leaking the stored user row', async () => {
  const { adminKey } = await setupControlPlaneTest({ adminKey: 'real-admin' });
  const compare = vi.fn((a: Uint8Array, b: Uint8Array) => a.every((byte, index) => byte === b[index]));
  initTimingSafeEqual(compare);

  for (const password of ['fake-admin', 'x']) {
    const rejected = await login('', password);
    assertEquals(rejected.status, 401);
    assertEquals(await rejected.json(), { error: 'Invalid username or password' });
  }

  const response = await login('', adminKey);
  assertEquals(response.status, 200);
  const body = await response.json() as { token: string; user: unknown };
  expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  assertEquals(body.user, { id: 1, username: 'admin', isAdmin: true, upstreamIds: null });
  assertEquals(Object.keys(body).toSorted(), ['token', 'user']);
  expect(compare).toHaveBeenCalledTimes(3);
  for (const [candidate, expected] of compare.mock.calls) {
    expect(candidate).toHaveLength(32);
    expect(expected).toHaveLength(32);
  }
});

test.each([
  { name: 'Node dev with ADMIN_KEY unset', runtime: 'node' as const, adminKey: null, production: false, edge: false, expected: 200 },
  { name: 'Node production with empty ADMIN_KEY', runtime: 'node' as const, adminKey: '', production: true, edge: false, expected: 401 },
  { name: 'Cloudflare dev with ADMIN_KEY unset', runtime: 'cloudflare' as const, adminKey: null, production: false, edge: false, expected: 200 },
  { name: 'Cloudflare edge with empty ADMIN_KEY', runtime: 'cloudflare' as const, adminKey: '', production: false, edge: true, expected: 401 },
])('/auth/login passwordless policy: $name', async ({ runtime, adminKey, production, edge, expected }) => {
  await setupControlPlaneTest({ adminKey });
  initRuntimeKind(runtime);
  if (production) vi.stubEnv('NODE_ENV', 'production');
  const response = await requestControlPlane('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(edge ? { 'cf-ray': '9a1b2c3d4e5f6789-SJC' } : {}),
    },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, expected);
});

test('/auth/login matches usernames case-insensitively, rejects a wrong password, and issues a usable session', async () => {
  const { repo } = await setupControlPlaneTest();
  await repo.users.save({
    id: 3,
    username: 'Alice',
    passwordHash: TEST_PASSWORD_HASH,
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const rejected = await login('alice', 'wrong-password');
  assertEquals(rejected.status, 401);
  assertEquals(await rejected.json(), { error: 'Invalid username or password' });

  const response = await login('ALICE', TEST_PASSWORD);
  assertEquals(response.status, 200);
  const body = await response.json() as { token: string; user: unknown };
  assertEquals(body.user, { id: 3, username: 'Alice', isAdmin: false, upstreamIds: null });

  const me = await requestControlPlane('/auth/me', { headers: { 'x-floway-session': body.token } });
  assertEquals(me.status, 200);
  assertEquals(await me.json(), {
    user: { id: 3, username: 'Alice', isAdmin: false, upstreamIds: null },
    viaApiKey: false,
    apiKey: null,
  });
});

test('/auth/login gives missing users and users without passwords the same rejection', async () => {
  const { repo } = await setupControlPlaneTest();
  await repo.users.save({
    id: 3,
    username: 'pending',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  for (const username of ['missing', 'pending']) {
    const response = await login(username, 'anything');
    assertEquals(response.status, 401);
    assertEquals(await response.json(), { error: 'Invalid username or password' });
  }
});

test('/auth/login preserves malformed JSON as an HTTP 400', async () => {
  const response = await requestControlPlane('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assertEquals(response.status, 400);
  assertEquals(await response.text(), 'Malformed JSON in request body');
});

test('/auth/login exposes a missing seed admin as an internal invariant failure', async () => {
  const { repo, adminKey } = await setupControlPlaneTest();
  const admin = await repo.users.getById(1);
  assertExists(admin);
  await repo.users.save({ ...admin, deletedAt: '2026-01-01T00:00:00.000Z' });
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await login('', adminKey);
    assertEquals(response.status, 500);
    const body = await response.json() as { error: { message: string; stack?: string } };
    assertEquals(body.error.message, 'ADMIN_KEY login: seed admin (user 1) is missing');
    expect(body.error.stack).toContain('ADMIN_KEY login: seed admin');
  } finally {
    consoleSpy.mockRestore();
  }
});

test('/auth/logout deletes only the current session', async () => {
  const { repo } = await setupControlPlaneTest();
  const sessionA = await repo.sessions.create(1);
  const sessionB = await repo.sessions.create(1);

  const response = await requestControlPlane('/auth/logout', {
    method: 'POST',
    headers: { 'x-floway-session': sessionA.id },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
  expect(await repo.sessions.getByIdAndTouch(sessionA.id)).toBeNull();
  expect(await repo.sessions.getByIdAndTouch(sessionB.id)).not.toBeNull();
});

test('/auth/me identifies API-key authentication without exposing key material', async () => {
  const { apiKey } = await setupControlPlaneTest();
  const response = await requestControlPlane('/auth/me', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    user: { id: 2, username: 'tester', isAdmin: false, upstreamIds: null },
    viaApiKey: true,
    apiKey: { id: apiKey.id, name: apiKey.name },
  });
});
