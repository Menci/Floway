import { test } from 'vitest';

import { requestApp, setupAppTest } from './test-utils/app.ts';
import { DEFAULT_WEB_SEARCH_CONFIG } from '../src/data-plane/tools/web-search/config.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

test('session token grants control-plane access but is rejected on data-plane', async () => {
  const { adminSession } = await setupAppTest();

  const exportResponse = await requestApp('/api/export', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(exportResponse.status, 200);

  const modelsResponse = await requestApp('/v1/models', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(modelsResponse.status, 401);
});

test('ADMIN_KEY presented as x-api-key on data plane is rejected', async () => {
  const { adminKey } = await setupAppTest();
  const response = await requestApp('/v1/models', { headers: { 'x-api-key': adminKey } });
  assertEquals(response.status, 401);
});

test('uncaught internal errors include debug details in the HTTP body', async () => {
  const { repo, apiKey } = await setupAppTest();
  repo.apiKeys.findByRawKey = () => Promise.reject(new Error('api key lookup failed'));

  const response = await requestApp('/api/keys', {
    method: 'GET',
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error.type, 'internal_error');
  assertEquals(body.error.name, 'Error');
  assertEquals(body.error.message, 'api key lookup failed');
  assertEquals(body.error.method, 'GET');
  assertEquals(body.error.path, '/api/keys');
  assertExists(body.error.stack);
});

test('API key users only see their own key in /api/keys', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 0,
  });

  const response = await requestApp('/api/keys', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 1);
  assertEquals(body[0].id, apiKey.id);
  assertEquals(body[0].key, apiKey.key);
});

test('Owner-via-API-key can rotate their own key', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp(`/api/keys/${apiKey.id}/rotate`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
});

test('API key users cannot mutate /api/search-config routes', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/search-config', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: JSON.stringify(DEFAULT_WEB_SEARCH_CONFIG),
  });

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: 'Admin privileges required' });
});

test('usage endpoints require an explicit view', async () => {
  const { apiKey } = await setupAppTest();
  const paths = [
    '/api/token-usage?start=2026-03-15T00&end=2026-03-16T00',
    '/api/search-usage?start=2026-03-15T00&end=2026-03-16T00',
  ];
  for (const path of paths) {
    const response = await requestApp(path, { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 400, path);
    assertEquals(await response.json(), { error: "view must be 'all-by-user' or 'self-by-key'" }, path);
  }
});
