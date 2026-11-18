import { test } from 'vitest';

import { requestApp, setupAppTest } from './test-utils/app.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

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
    randomizeUpstreams: false,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
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
