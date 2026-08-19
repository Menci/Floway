import { expect, test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const providerBody = (overrides: Record<string, unknown> = {}) => ({
  id: 'custom',
  display_name: 'Example ID',
  enabled: true,
  client_id: 'floway-client',
  client_secret: 'floway-secret',
  authorization_endpoint: 'https://id.example.com/oauth/authorize',
  token_endpoint: 'https://id.example.com/oauth/token',
  userinfo_endpoint: 'https://id.example.com/api/user',
  scopes: ['profile', 'email'],
  client_authentication: 'client_secret_post',
  user_id_claim: null,
  username_claim: null,
  authorization_params: { prompt: 'login' },
  access_policy: { logic: 'and', conditions: [] },
  ...overrides,
});

const providerUpdateBody = (overrides: Record<string, unknown> = {}) => {
  const { id: _id, client_secret: _clientSecret, ...body } = providerBody(overrides);
  return body;
};

const adminJson = (adminSession: string, method: string, body: unknown): RequestInit => ({
  method,
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  body: JSON.stringify(body),
});

test('OAuth2 configuration API requires an administrator', async () => {
  const { apiKey } = await setupAppTest();

  for (const path of ['/api/oauth2/settings', '/api/oauth2/providers']) {
    const response = await requestApp(path, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 403);
  }
});

test('administrator configures OAuth2 and controls its public availability immediately', async () => {
  const { adminSession } = await setupAppTest();

  const createdResponse = await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody()));
  assertEquals(createdResponse.status, 201);
  const created = await createdResponse.json() as Record<string, unknown>;
  assertEquals(created.client_secret_configured, true);
  assertEquals(created.access_policy, { logic: 'and', conditions: [] });
  assertEquals(Object.hasOwn(created, 'client_secret'), false);

  const unavailable = await requestApp('/auth/oauth2/providers', {});
  assertEquals(await unavailable.json(), { providers: [] });

  const settingsResponse = await requestApp('/api/oauth2/settings', adminJson(adminSession, 'PUT', {
    public_base_url: 'https://floway.example.com/',
  }));
  assertEquals(settingsResponse.status, 200);
  assertEquals(await settingsResponse.json(), { public_base_url: 'https://floway.example.com' });

  const available = await requestApp('/auth/oauth2/providers', {});
  assertEquals(await available.json(), { providers: [{ id: 'custom', displayName: 'Example ID' }] });

  const updateBody = providerUpdateBody({
    enabled: false,
    display_name: 'Renamed ID',
  });
  const updatedResponse = await requestApp('/api/oauth2/providers/custom', adminJson(adminSession, 'PUT', updateBody));
  assertEquals(updatedResponse.status, 200);
  const updated = await updatedResponse.json() as Record<string, unknown>;
  assertEquals(updated.client_secret_configured, true);
  assertEquals(Object.hasOwn(updated, 'client_secret'), false);
  assertEquals(await (await requestApp('/auth/oauth2/providers', {})).json(), { providers: [] });

  const listedResponse = await requestApp('/api/oauth2/providers', {
    headers: { 'x-floway-session': adminSession },
  });
  const listed = await listedResponse.json() as Array<Record<string, unknown>>;
  assertEquals(listed.length, 1);
  assertEquals(Object.hasOwn(listed[0], 'client_secret'), false);

  const deletedResponse = await requestApp('/api/oauth2/providers/custom', {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(deletedResponse.status, 204);
  assertEquals(await (await requestApp('/api/oauth2/providers', {
    headers: { 'x-floway-session': adminSession },
  })).json(), []);
});

test('OAuth2 provider update without a secret preserves the stored secret', async () => {
  const { adminSession, repo } = await setupAppTest();
  assertEquals((await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody()))).status, 201);

  const body = providerUpdateBody({ display_name: 'Updated ID' });
  assertEquals((await requestApp('/api/oauth2/providers/custom', adminJson(adminSession, 'PUT', body))).status, 200);

  const stored = await repo.oauth2Config.getProviderById('custom');
  assertExists(stored);
  assertEquals(stored.clientSecret, 'floway-secret');
  assertEquals(stored.displayName, 'Updated ID');
});

test('OAuth2 configuration API rejects duplicate IDs and unsafe protocol configuration', async () => {
  const { adminSession } = await setupAppTest();
  assertEquals((await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody()))).status, 201);

  const duplicate = await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody()));
  assertEquals(duplicate.status, 409);

  const badEndpoint = await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody({
    id: 'bad-endpoint',
    authorization_endpoint: 'javascript:alert(1)',
  })));
  assertEquals(badEndpoint.status, 400);
  expect((await badEndpoint.json() as { error: string }).error).toContain('must use http or https');

  const reservedParameter = await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody({
    id: 'bad-params',
    authorization_params: { state: 'operator-value' },
  })));
  assertEquals(reservedParameter.status, 400);
  expect((await reservedParameter.json() as { error: string }).error).toContain('must not override state');

  const badBaseUrl = await requestApp('/api/oauth2/settings', adminJson(adminSession, 'PUT', {
    public_base_url: 'https://floway.example.com/prefix',
  }));
  assertEquals(badBaseUrl.status, 400);
  expect((await badBaseUrl.json() as { error: string }).error).toContain('must be an origin');
});

test('administrator configures a generic UserInfo claim access policy on the provider', async () => {
  const { adminSession, repo } = await setupAppTest();
  const accessPolicy = {
    logic: 'or',
    conditions: [
      { field: 'groups', op: 'contains', value: 'POPIPA-l10n:owners' },
      { field: 'groups', op: 'contains', value: 'canneed:owners' },
    ],
  };
  const response = await requestApp('/api/oauth2/providers', adminJson(adminSession, 'POST', providerBody({
    scopes: ['openid', 'groups'],
    access_policy: accessPolicy,
  })));
  assertEquals(response.status, 201);
  assertEquals((await response.json() as Record<string, unknown>).access_policy, accessPolicy);
  assertEquals((await repo.oauth2Config.getProviderById('custom'))?.accessPolicy, accessPolicy);

  const unsupportedOperator = await requestApp('/api/oauth2/providers/custom', adminJson(adminSession, 'PUT', providerUpdateBody({
    access_policy: {
      logic: 'or',
      conditions: [{ field: 'groups', op: 'equals', value: 'POPIPA-l10n:owners' }],
    },
  })));
  assertEquals(unsupportedOperator.status, 400);
});
