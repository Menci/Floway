import { expect, test, vi } from 'vitest';

// Copilot OAuth poll handler warms the SWR models cache after rotating the PAT.
// The warm calls Copilot's /models which the existing fetch mock here doesn't
// stub, sending the request through copilotAuthedFetch's retry/backoff and
// stalling the test by ~7s. Stub the cache layer to a no-op — warm semantics
// have dedicated coverage in models-cache_test.ts.
vi.mock('../../data-plane/providers/models-cache.ts', () => ({
  fetchUpstreamModelsCached: () => Promise.resolve([]),
  clearInFlightForTesting: () => {},
}));

import { hashPassword } from '../../shared/passwords.ts';
import { buildCopilotUpstreamRecord, requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, assertStringIncludes, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const githubUser = {
  id: 777,
  login: 'octo-auth',
  name: 'Octo Auth',
  avatar_url: 'https://example.com/octo-auth.png',
};

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

test('/auth/login with username + matching password issues a session', async () => {
  const { repo } = await setupAppTest();
  await repo.users.save({
    id: 2,
    username: 'alice',
    passwordHash: await hashPassword('hunter2'),
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
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
    canViewGlobalTelemetry: false,
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
    canViewGlobalTelemetry: false,
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
    canViewGlobalTelemetry: false,
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
  const body = (await response.json()) as { user: { id: number; isAdmin: boolean; canViewGlobalTelemetry: boolean }; viaApiKey: boolean; apiKey: unknown };
  assertEquals(body.user.id, 1);
  assertEquals(body.user.isAdmin, true);
  assertEquals(body.user.canViewGlobalTelemetry, true);
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

test('old /auth GitHub management routes are removed', async () => {
  const { repo } = await setupAppTest();
  const session = await repo.sessions.create(1);

  const start = await requestApp('/auth/github', { method: 'GET', headers: { 'x-floway-session': session.id } });
  const order = await requestApp('/auth/github/order', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': session.id },
    body: JSON.stringify({ user_ids: [1] }),
  });

  assertEquals(start.status, 404);
  assertEquals(order.status, 404);
});

test('/api/upstreams/copilot/auth/start starts GitHub device flow', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/device/code') {
        return jsonResponse({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/start', { method: 'POST', headers: { 'x-floway-session': adminSession } });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    },
  );
});

test('/api/upstreams/copilot/auth/poll creates a Copilot upstream row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_new' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ copilot_plan: 'enterprise' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as Record<string, any>;
      assertEquals(body.status, 'complete');
      assertEquals(/^up_[0-9a-f]{24}$/.test(body.upstream.id), true);
      assertEquals(body.upstream.id.includes('copilot'), false);
      assertEquals(body.upstream.provider, 'copilot');
      assertEquals(body.upstream.config.githubToken, undefined);
      assertEquals(body.upstream.config.githubTokenSet, true);
    },
  );

  const rows = await repo.upstreams.list();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].provider, 'copilot');
  assertEquals((rows[0].config as Record<string, any>).githubToken, 'ghu_new');
  assertEquals((rows[0].config as Record<string, any>).accountType, 'enterprise');
  assertEquals((rows[0].config as Record<string, any>).user.id, 777);
});

test('/api/upstreams/copilot/auth/poll rejects failed GitHub user lookup without saving an upstream', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_user' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse({ message: 'bad credentials' }, 401);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'GitHub user lookup failed: 401');
      assertStringIncludes(body.error, 'bad credentials');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/auth/poll rejects failed Copilot account type lookup without saving an upstream', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_plan' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ message: 'no copilot seat' }, 403);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'GitHub Copilot account type detection failed: 403');
      assertStringIncludes(body.error, 'no copilot seat');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/auth/poll rejects unknown Copilot account type without saving an upstream', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_unknown_plan' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ copilot_plan: 'free' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 502);
      assertEquals((await response.json()) as Record<string, unknown>, { error: 'Unknown GitHub Copilot plan: "free"' });
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/auth/poll updates an existing row for the same GitHub user', async () => {
  const { repo, adminSession, githubAccount } = await setupAppTest({
    githubAccount: {
      token: 'ghu_old',
      accountType: 'individual',
      user: githubUser,
    },
  });
  const existing = buildCopilotUpstreamRecord(githubAccount, { id: 'up_existing_copilot', name: 'Pinned Copilot', sortOrder: 9 });
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(existing);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_refreshed' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ copilot_plan: 'business' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });
      assertEquals(response.status, 200);
      assertEquals(((await response.json()) as Record<string, any>).upstream.id, 'up_existing_copilot');
    },
  );

  const rows = await repo.upstreams.list();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, 'up_existing_copilot');
  assertEquals(rows[0].name, 'Pinned Copilot');
  assertEquals(rows[0].sortOrder, 9);
  assertEquals((rows[0].config as Record<string, any>).githubToken, 'ghu_refreshed');
  assertEquals((rows[0].config as Record<string, any>).accountType, 'business');
});
