import { afterEach, expect, test } from 'vitest';

import { getOAuth2Config } from '../../../src/control-plane/auth/oauth2-config.ts';
import type { OAuth2Provider } from '../../../src/repo/types.ts';
import type { InMemoryRepo } from '../../repo/memory.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { initFetch } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const provider: OAuth2Provider = {
  id: 'custom',
  displayName: 'Example ID',
  enabled: true,
  clientId: 'floway-client',
  clientSecret: 'floway-secret',
  authorizationEndpoint: 'https://id.example.com/oauth/authorize',
  tokenEndpoint: 'https://id.example.com/oauth/token',
  userInfoEndpoint: 'https://id.example.com/api/user',
  scopes: ['profile'],
  clientAuthentication: 'client_secret_post',
  userIdClaim: null,
  usernameClaim: null,
  authorizationParams: {},
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

afterEach(() => {
  initFetch((url, init) => fetch(url, init as RequestInit));
});

const configureOAuth2 = async (repo: InMemoryRepo, providers: OAuth2Provider[] = [provider]) => {
  await repo.oauth2Config.saveSettings({
    publicBaseUrl: 'https://floway.example.com',
    updatedAt: provider.updatedAt,
  });
  for (const item of providers) await repo.oauth2Config.saveProvider(item);
};

const start = async (): Promise<{ state: string; location: URL; cookie: string }> => {
  const response = await requestApp('/auth/oauth2/custom/start', { method: 'GET' });
  assertEquals(response.status, 302);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  const location = new URL(response.headers.get('location')!);
  const state = location.searchParams.get('state');
  assertExists(state);
  assertEquals(location.origin + location.pathname, 'https://id.example.com/oauth/authorize');
  assertEquals(location.searchParams.get('client_id'), 'floway-client');
  assertEquals(location.searchParams.get('redirect_uri'), 'https://floway.example.com/auth/oauth2/custom/callback');
  assertEquals(location.searchParams.get('scope'), 'profile');
  assertEquals(location.searchParams.get('code_challenge_method'), 'S256');
  expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  assertEquals(location.searchParams.has('client_secret'), false);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assertExists(cookie);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
  expect(response.headers.get('set-cookie')).toContain('Secure');
  return { state, location, cookie };
};

const callbackHandoff = async (state: string, cookie: string): Promise<string> => {
  const response = await requestApp(`/auth/oauth2/custom/callback?state=${encodeURIComponent(state)}&code=provider-code`, {
    method: 'GET',
    headers: { cookie },
  });
  assertEquals(response.status, 302);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  const location = new URL(response.headers.get('location')!);
  assertEquals(location.origin + location.pathname, 'https://floway.example.com/');
  const fragment = new URLSearchParams(location.hash.slice(1));
  const handoff = fragment.get('oauth2_result');
  assertExists(handoff);
  return handoff;
};

test('custom OAuth2 provider supports self-service registration and later login', async () => {
  const { repo } = await setupAppTest();
  await configureOAuth2(repo);
  let tokenRequests = 0;
  initFetch(async (url, init) => {
    if (url === 'https://id.example.com/oauth/token') {
      tokenRequests++;
      const body = new URLSearchParams(String(init.body));
      assertEquals(body.get('client_id'), 'floway-client');
      assertEquals(body.get('client_secret'), 'floway-secret');
      assertEquals(body.get('code'), 'provider-code');
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      return Response.json({ access_token: `provider-access-${tokenRequests}` });
    }
    if (url === 'https://id.example.com/api/user') {
      assertEquals(new Headers(init.headers).get('authorization'), `Bearer provider-access-${tokenRequests}`);
      return Response.json({ id: 42, login: 'alice@example.com' });
    }
    throw new Error(`unexpected OAuth2 request: ${url}`);
  });

  const providersResponse = await requestApp('/auth/oauth2/providers', { method: 'GET' });
  assertEquals(providersResponse.status, 200);
  assertEquals(await providersResponse.json(), { providers: [{ id: 'custom', displayName: 'Example ID' }] });

  const first = await start();
  const registrationToken = await callbackHandoff(first.state, first.cookie);
  const pendingResponse = await requestApp('/auth/oauth2/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: registrationToken }),
  });
  assertEquals(pendingResponse.status, 200);
  assertEquals(pendingResponse.headers.get('cache-control'), 'no-store');
  const pending = await pendingResponse.json() as Record<string, unknown>;
  assertEquals(pending.status, 'registration_required');
  assertEquals(pending.providerDisplayName, 'Example ID');
  assertEquals(pending.providerLogin, 'alice@example.com');
  assertEquals(pending.suggestedUsername, 'alice-example.com');

  const registrationResponse = await requestApp('/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registrationToken, username: 'alice' }),
  });
  assertEquals(registrationResponse.status, 201);
  const registration = await registrationResponse.json() as { token: string; user: { id: number; username: string; isAdmin: boolean } };
  assertEquals(registration.user.username, 'alice');
  assertEquals(registration.user.isAdmin, false);
  expect(registration.token).toMatch(/^[0-9a-f]{64}$/);
  assertEquals((await repo.apiKeys.listByUserId(registration.user.id)).length, 1);
  assertEquals((await repo.oauth2.listAccounts())[0]?.providerUserId, '42');

  const reused = await requestApp('/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registrationToken, username: 'alice-2' }),
  });
  assertEquals(reused.status, 400);

  const second = await start();
  const loginToken = await callbackHandoff(second.state, second.cookie);
  const loginResponse = await requestApp('/auth/oauth2/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: loginToken }),
  });
  assertEquals(loginResponse.status, 200);
  const login = await loginResponse.json() as { status: string; token: string; user: { id: number } };
  assertEquals(login.status, 'authenticated');
  assertEquals(login.user.id, registration.user.id);
  expect(login.token).toMatch(/^[0-9a-f]{64}$/);

  const loginReplay = await requestApp('/auth/oauth2/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: loginToken }),
  });
  assertEquals(loginReplay.status, 400);
  assertEquals(tokenRequests, 2);
});

test('OAuth2 callback rejects a replayed state before contacting the provider', async () => {
  const { repo } = await setupAppTest();
  await configureOAuth2(repo);
  let requests = 0;
  initFetch(() => {
    requests++;
    return Promise.reject(new Error('must not fetch'));
  });

  const { state, cookie } = await start();
  const cancelled = await requestApp(`/auth/oauth2/custom/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
    method: 'GET',
    headers: { cookie },
  });
  assertEquals(cancelled.status, 302);
  expect(cancelled.headers.get('location')).toContain('oauth2_error=access_denied');

  const replay = await requestApp(`/auth/oauth2/custom/callback?state=${encodeURIComponent(state)}&code=replayed`, { method: 'GET' });
  assertEquals(replay.status, 302);
  expect(replay.headers.get('location')).toContain('OAuth2+state+is+invalid+or+expired');
  assertEquals(requests, 0);
});

test('OAuth2 callback rejects a state initiated in another browser', async () => {
  const { repo } = await setupAppTest();
  await configureOAuth2(repo);
  let requests = 0;
  initFetch(() => {
    requests++;
    return Promise.reject(new Error('must not fetch'));
  });

  const { state, cookie } = await start();
  const foreignBrowser = await requestApp(`/auth/oauth2/custom/callback?state=${encodeURIComponent(state)}&code=stolen`, { method: 'GET' });
  assertEquals(foreignBrowser.status, 302);
  expect(foreignBrowser.headers.get('location')).toContain('did+not+originate+in+this+browser');

  const originalBrowser = await requestApp(`/auth/oauth2/custom/callback?state=${encodeURIComponent(state)}&code=now-replayed`, {
    method: 'GET',
    headers: { cookie },
  });
  assertEquals(originalBrowser.status, 302);
  expect(originalBrowser.headers.get('location')).toContain('OAuth2+state+is+invalid+or+expired');
  assertEquals(requests, 0);
});

test('custom OAuth2 provider supports Basic client auth, authorization parameters, and dotted claims', async () => {
  const { repo } = await setupAppTest();
  await configureOAuth2(repo, [{
    ...provider,
    clientAuthentication: 'client_secret_basic',
    userIdClaim: 'data.subject',
    usernameClaim: 'data.handle',
    authorizationParams: { prompt: 'login' },
  }]);
  initFetch(async (url, init) => {
    if (url === 'https://id.example.com/oauth/token') {
      const headers = new Headers(init.headers);
      assertEquals(headers.get('authorization'), `Basic ${btoa('floway-client:floway-secret')}`);
      const body = new URLSearchParams(String(init.body));
      assertEquals(body.has('client_id'), false);
      assertEquals(body.has('client_secret'), false);
      return Response.json({ access_token: 'provider-access' });
    }
    if (url === 'https://id.example.com/api/user') {
      return Response.json({ data: { subject: 'stable-user-id', handle: 'nested-login' } });
    }
    throw new Error(`unexpected OAuth2 request: ${url}`);
  });

  const started = await start();
  assertEquals(started.location.searchParams.get('prompt'), 'login');
  const handoff = await callbackHandoff(started.state, started.cookie);
  const response = await requestApp('/auth/oauth2/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: handoff }),
  });

  assertEquals(response.status, 200);
  const pending = await response.json() as Record<string, unknown>;
  assertEquals(pending.providerLogin, 'nested-login');
});

test('OAuth2 configuration rejects authorization parameters that replace protocol protections', async () => {
  const { repo } = await setupAppTest();
  await configureOAuth2(repo, [{
    ...provider,
    authorizationParams: { state: 'operator-value' },
  }]);

  await expect(getOAuth2Config()).rejects.toThrow('authorizationParams must not override state');
});

test('OAuth2 configuration rejects a public base URL with an unsupported path prefix', async () => {
  const { repo } = await setupAppTest();
  await repo.oauth2Config.saveSettings({
    publicBaseUrl: 'https://floway.example.com/prefix',
    updatedAt: provider.updatedAt,
  });

  await expect(getOAuth2Config()).rejects.toThrow('must be an origin');
});
