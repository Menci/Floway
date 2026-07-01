import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { authMiddleware } from './auth.ts';
import { initRepo } from '../repo/index.ts';
import { setupAppTest } from '../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const authTestApp = () => {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.all('*', c => c.text('ok'));
  return app;
};

test('API key on data-plane is accepted', async () => {
  const { apiKey } = await setupAppTest();
  const app = authTestApp();
  const response = await app.request('/v1beta/models/gemini-test:generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.text(), 'ok');
});

test('ADMIN_KEY presented as x-api-key on any path is rejected with login hint', async () => {
  const { adminKey } = await setupAppTest();
  const app = authTestApp();

  for (const path of ['/api/users', '/v1/chat/completions', '/v1beta/models']) {
    const response = await app.request(path, { method: 'POST', headers: { 'x-api-key': adminKey } });
    assertEquals(response.status, 401);
    expect(await response.text()).toMatch(/POST \/auth\/login/);
  }
});

test('session token grants control-plane access but is rejected on data-plane', async () => {
  const { repo } = await setupAppTest();
  const session = await repo.sessions.create(1);
  const app = authTestApp();

  const okResponse = await app.request('/api/keys', { headers: { 'x-floway-session': session.id } });
  assertEquals(okResponse.status, 200);

  const denied = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'x-floway-session': session.id } });
  assertEquals(denied.status, 401);
});

test('session token for a deleted user is invalidated', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'alice',
    passwordHash: 'pbkdf2-sha256$600000$YQ==$YQ==',
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  const session = await repo.sessions.create(2);
  await repo.users.softDelete(2);

  const app = authTestApp();
  const response = await app.request('/api/keys', { headers: { 'x-floway-session': session.id } });
  assertEquals(response.status, 401);

  // The dead session is cleaned up so the next request is a clean miss, not a stale row.
  const followUp = await app.request('/api/keys', { headers: { 'x-floway-session': session.id } });
  assertEquals(followUp.status, 401);
  initRepo(repo);
  expect(await repo.sessions.getByIdAndTouch(session.id)).toBeNull();
});

test('API key whose owner was deleted is rejected', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'alice',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  });
  await repo.apiKeys.save({ ...apiKey, id: 'key_alice', userId: 2, key: 'raw_alice', deletedAt: null });
  await repo.users.softDelete(2);

  const app = authTestApp();
  const response = await app.request('/v1beta/models/gemini-test:generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': 'raw_alice' },
  });
  assertEquals(response.status, 401);
});

// A present-but-empty higher-priority source must not shadow a valid
// lower-priority credential. '' is not nullish, so the raw `??` chain used to
// latch onto it and 401 the request without ever consulting the real key —
// exactly what non-standard clients (e.g. Xcode's Claude agent custom-endpoint
// workaround) trigger by sending an empty x-api-key alongside a real Bearer.
test('empty x-api-key does not shadow a valid Authorization: Bearer', async () => {
  const { apiKey } = await setupAppTest();
  const app = authTestApp();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-api-key': '', authorization: `Bearer ${apiKey.key}` },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.text(), 'ok');
});

test('empty ?key= query does not shadow a valid x-goog-api-key', async () => {
  const { apiKey } = await setupAppTest();
  const app = authTestApp();
  const response = await app.request('/v1beta/models/gemini-test:generateContent?key=', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
});

test('whitespace-only x-api-key falls through to a valid Bearer', async () => {
  const { apiKey } = await setupAppTest();
  const app = authTestApp();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-api-key': '   ', authorization: `Bearer ${apiKey.key}` },
  });
  assertEquals(response.status, 200);
});

test('a key with stray surrounding whitespace is trimmed and accepted', async () => {
  const { apiKey } = await setupAppTest();
  const app = authTestApp();
  const response = await app.request('/v1beta/models/gemini-test:generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': `  ${apiKey.key}  ` },
  });
  assertEquals(response.status, 200);
});

test('Authorization: Bearer with no value is rejected', async () => {
  await setupAppTest();
  const app = authTestApp();
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' },
  });
  assertEquals(response.status, 401);
});
