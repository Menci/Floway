import { test } from 'vitest';

import { DEFAULT_SEARCH_CONFIG } from './data-plane/tools/web-search/search-config.ts';
import { requestApp, setupAppTest } from './test-helpers.ts';
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
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
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
    body: JSON.stringify(DEFAULT_SEARCH_CONFIG),
  });

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: 'Admin privileges required' });
});

test('/api/token-usage scopes to the actor\'s keys when called with an API key', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });
  await repo.usage.set({
    keyId: apiKey.id,
    model: 'claude-sonnet-4',
    upstream: null,
    modelKey: 'claude-sonnet-4',
    hour: '2026-03-15T10',
    tier: null,
    requests: 2,
    tokens: { input: 10, output: 5, input_cache_read: 4, input_cache_write: 1 },
    cost: null,
  });
  await repo.usage.set({
    keyId: 'key_other',
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-15T11',
    tier: null,
    requests: 1,
    tokens: { input: 20, output: 8, input_cache_read: 6, input_cache_write: 2 },
    cost: null,
  });

  const response = await requestApp('/api/token-usage?start=2026-03-15T00&end=2026-03-16T00', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  // Non-admin actor sees only their own key's rows; the other user's row is excluded.
  assertEquals(body.length, 1);
  assertEquals(body[0].keyId, apiKey.id);
  assertEquals(body[0].keyName, 'Primary key');
  assertEquals(body[0].tokens.input_cache_read, 4);
  assertEquals(body[0].tokens.input_cache_write, 1);
});

test('/api/token-usage in self-by-key mode includes per-key metadata for the actor only', async () => {
  const { repo, apiKey } = await setupAppTest();
  // Add a second key under the same user; they should both surface.
  await repo.apiKeys.save({
    id: 'key_actor_secondary',
    userId: apiKey.userId,
    name: 'Actor secondary',
    key: 'raw_actor_secondary',
    createdAt: '2026-03-16T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  });
  await repo.usage.set({
    keyId: 'key_actor_secondary',
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-16T10',
    tier: null,
    requests: 1,
    tokens: { input: 20, output: 8 },
    cost: null,
  });

  const response = await requestApp('/api/token-usage?start=2026-03-16T00&end=2026-03-17T00&include_key_metadata=1', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.records.length, 1);
  assertEquals(body.records[0].keyId, 'key_actor_secondary');
  assertEquals(body.keys, [
    { id: apiKey.id, name: apiKey.name, createdAt: apiKey.createdAt },
    { id: 'key_actor_secondary', name: 'Actor secondary', createdAt: '2026-03-16T00:00:00.000Z' },
  ]);
});

test('/api/token-usage all-by-user view aggregates across keys per user', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.usage.set({
    keyId: apiKey.id,
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-15T10',
    tier: null,
    requests: 1,
    tokens: { input: 10, output: 5 },
    cost: null,
  });

  const response = await requestApp(
    '/api/token-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user',
    { headers: { 'x-floway-session': adminSession } },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 1);
  assertEquals(body[0].userId, apiKey.userId);
  assertEquals(body[0].tokens.input, 10);
});

test('/api/token-usage rejects all-by-user from a user without canViewGlobalTelemetry', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp(
    '/api/token-usage?start=2026-03-15T00&end=2026-03-16T00&view=all-by-user',
    { headers: { 'x-api-key': apiKey.key } },
  );
  assertEquals(response.status, 403);
});

test('/api/token-usage merges Claude variants into backend base model records', async () => {
  const { repo, apiKey } = await setupAppTest();
  const shared = {
    keyId: apiKey.id,
    hour: '2026-03-17T10',
    upstream: 'copilot:1',
    tier: null,
    requests: 1,
    tokens: { input: 10, output: 5, input_cache_read: 2, input_cache_write: 1 },
  };

  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7',
    cost: null,
  });
  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7-xhigh',
    cost: null,
  });
  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7-1m-internal',
    cost: null,
  });
  await repo.usage.set({
    ...shared,
    model: 'gpt-5.3-codex',
    modelKey: 'gpt-5.3-codex',
    tokens: { input: 3, output: 4 },
    cost: null,
  });

  const response = await requestApp('/api/token-usage?start=2026-03-17T00&end=2026-03-18T00', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 2);
  const opus = body.find((record: { model: string }) => record.model === 'claude-opus-4-7');
  const gpt = body.find((record: { model: string }) => record.model === 'gpt-5.3-codex');
  assertExists(opus);
  assertExists(gpt);
  assertEquals(opus.requests, 3);
  assertEquals(opus.tokens.input, 30);
  assertEquals(opus.tokens.output, 15);
  assertEquals(opus.tokens.input_cache_read, 6);
  assertEquals(opus.tokens.input_cache_write, 3);
});
