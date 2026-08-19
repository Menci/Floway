import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('GET /api/site-settings is public and returns the default name', async () => {
  await setupAppTest();
  const response = await requestApp('/api/site-settings', {});

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { name: 'Floway' });
});

test('PUT /api/site-settings trims and persists a name for administrators', async () => {
  const { adminSession, repo } = await setupAppTest();
  const response = await requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: '  My Gateway  ' }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { name: 'My Gateway' });
  assertEquals(await repo.siteSettings.get(), { name: 'My Gateway' });
});

test('PUT /api/site-settings requires an administrator and validates the name', async () => {
  const { adminSession, apiKey } = await setupAppTest();
  const nonAdmin = await requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ name: 'Nope' }),
  });
  const empty = await requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: '   ' }),
  });

  assertEquals(nonAdmin.status, 403);
  assertEquals(empty.status, 400);
});
