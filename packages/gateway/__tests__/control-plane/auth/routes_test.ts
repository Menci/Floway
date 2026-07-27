import { afterEach, expect, test, vi } from 'vitest';

import { hashPassword } from '../../../src/shared/passwords.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { initRuntimeKind } from '@floway-dev/platform';
import { assertEquals } from '@floway-dev/test-utils';

// vitest.setup pins the runtime kind to 'node'; the CF-side tests below
// re-init and this restores the default so they don't leak.
afterEach(() => {
  initRuntimeKind('node');
  vi.unstubAllEnvs();
});

test('/auth/login with blank username + ADMIN_KEY logs in as user 1', async () => {
  const { adminKey } = await setupAppTest();
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: adminKey }),
  });

  assertEquals(response.status, 200);
  const body = (await response.json()) as { token: string; user: { id: number; isAdmin: boolean; username: string } };
  expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  assertEquals(body.user.id, 1);
  assertEquals(body.user.isAdmin, true);
  assertEquals(body.user.username, 'admin');
});

test('/auth/login with blank username + wrong ADMIN_KEY rejects', async () => {
  await setupAppTest({ adminKey: 'real-admin' });
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: 'wrong-admin' }),
  });
  assertEquals(response.status, 401);
});

// Zero-config passwordless admin login: with no ADMIN_KEY set, a brand-new
// local instance still lets the operator in. The four cases below cover the
// dev/prod matrix on both runtimes — dev accepts, prod refuses. Node prod
// additionally hard-fails at boot (see apps/platform-node/entry.ts), but
// this per-request guard is the Cloudflare-side gate and Node
// defence-in-depth.

test('/auth/login on Node dev (empty ADMIN_KEY, NODE_ENV != production) grants passwordless admin login', async () => {
  await setupAppTest({ adminKey: '' });
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number; isAdmin: boolean } };
  assertEquals(body.user.id, 1);
  assertEquals(body.user.isAdmin, true);
});

test('/auth/login on Node with NODE_ENV=production refuses passwordless login when ADMIN_KEY is empty', async () => {
  await setupAppTest({ adminKey: '' });
  vi.stubEnv('NODE_ENV', 'production');
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, 401);
});

test('/auth/login on Cloudflare wrangler dev (empty ADMIN_KEY, no CF-Ray) grants passwordless admin login', async () => {
  await setupAppTest({ adminKey: '' });
  initRuntimeKind('cloudflare');
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number } };
  assertEquals(body.user.id, 1);
});

test('/auth/login on Cloudflare edge (CF-Ray present) refuses passwordless login when ADMIN_KEY is empty', async () => {
  await setupAppTest({ adminKey: '' });
  initRuntimeKind('cloudflare');
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-ray': '9a1b2c3d4e5f6789-SJC',
    },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, 401);
});

// A brand-new checkout has ADMIN_KEY entirely unset — not `''` but truly
// undefined — because platform-node's EnvGetter is `name => process.env[name]`
// and an unexported variable reads as undefined. The route must treat that
// state identically to an explicitly empty string, or fresh Node dev
// installs 500 on every login. Cloudflare has the same shape when the
// operator has no `.dev.vars`.

test('/auth/login on Node dev with ADMIN_KEY entirely unset (EnvGetter returns undefined) grants passwordless admin login', async () => {
  await setupAppTest({ adminKey: null });
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number; isAdmin: boolean } };
  assertEquals(body.user.id, 1);
  assertEquals(body.user.isAdmin, true);
});

test('/auth/login on Cloudflare wrangler dev with ADMIN_KEY entirely unset (no .dev.vars, no CF-Ray) grants passwordless admin login', async () => {
  await setupAppTest({ adminKey: null });
  initRuntimeKind('cloudflare');
  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number } };
  assertEquals(body.user.id, 1);
});

test('/auth/login with username + matching password issues a session', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'alice',
    passwordHash: await hashPassword('hunter2'),
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { token: string; user: { id: number; isAdmin: boolean } };
  assertEquals(body.user.id, 2);
  assertEquals(body.user.isAdmin, false);
});

test('/auth/login matches the username case-insensitively', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'Alice',
    passwordHash: await hashPassword('hunter2'),
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ALICE', password: 'hunter2' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number } };
  assertEquals(body.user.id, 2);
});

test('/auth/login with wrong password is rejected', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'alice',
    passwordHash: await hashPassword('hunter2'),
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'WRONG' }),
  });
  assertEquals(response.status, 401);
});

test('/auth/login refuses a user with no password set (must use admin reset path)', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'pending',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });

  const response = await requestApp('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'pending', password: 'anything' }),
  });
  assertEquals(response.status, 401);
});

test('/auth/logout deletes the current session only', async () => {
  const { repo } = await setupAppTest();
  const sessionA = await repo.sessions.create(1);
  const sessionB = await repo.sessions.create(1);

  const response = await requestApp('/auth/logout', {
    method: 'POST',
    headers: { 'x-floway-session': sessionA.id },
  });
  assertEquals(response.status, 200);

  expect(await repo.sessions.getByIdAndTouch(sessionA.id)).toBeNull();
  expect(await repo.sessions.getByIdAndTouch(sessionB.id)).not.toBeNull();
});

test('/auth/me returns the current user shape with viaApiKey:false for sessions', async () => {
  const { repo } = await setupAppTest();
  const session = await repo.sessions.create(1);

  const response = await requestApp('/auth/me', {
    method: 'GET',
    headers: { 'x-floway-session': session.id },
  });

  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number; isAdmin: boolean }; viaApiKey: boolean; apiKey: unknown };
  assertEquals(body.user.id, 1);
  assertEquals(body.user.isAdmin, true);
  assertEquals(body.viaApiKey, false);
  assertEquals(body.apiKey, null);
});

test('/auth/me reports viaApiKey:true and the API key metadata when authed via x-api-key', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/auth/me', {
    method: 'GET',
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = (await response.json()) as { user: { id: number }; viaApiKey: boolean; apiKey: { id: string; name: string } };
  assertEquals(body.viaApiKey, true);
  assertEquals(body.apiKey.id, apiKey.id);
  assertEquals(body.apiKey.name, apiKey.name);
});
