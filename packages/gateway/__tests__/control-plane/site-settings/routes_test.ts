import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const getSettings = (headers: Record<string, string> = {}) =>
  requestApp('/api/site-settings', { headers });

test('site settings are readable without a session and default to no override', async () => {
  await setupAppTest();

  const response = await getSettings();

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { site_name: null });
});

test('an admin stores the site name and the public read reflects it', async () => {
  const { adminSession } = await setupAppTest();

  const put = await requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ site_name: '  Menci Gateway  ' }),
  });

  assertEquals(put.status, 200);
  assertEquals(await put.json(), { site_name: 'Menci Gateway' });
  assertEquals(await (await getSettings()).json(), { site_name: 'Menci Gateway' });
});

test('clearing the name restores the built-in default', async () => {
  const { adminSession } = await setupAppTest();
  const put = (siteName: string | null) => requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ site_name: siteName }),
  });

  await put('Temp');
  const cleared = await put('   ');

  assertEquals(cleared.status, 200);
  assertEquals(await cleared.json(), { site_name: null });
  assertEquals(await (await getSettings()).json(), { site_name: null });
});

test('a non-admin session cannot change the site name', async () => {
  const { repo } = await setupAppTest();
  const operatorSession = (await repo.sessions.create(2)).id;

  const response = await requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': operatorSession },
    body: JSON.stringify({ site_name: 'Hijacked' }),
  });

  assertEquals(response.status, 403);
  assertEquals(await (await getSettings()).json(), { site_name: null });
});

test('the site name length limit is enforced before storage', async () => {
  const { adminSession } = await setupAppTest();

  const response = await requestApp('/api/site-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ site_name: 'x'.repeat(65) }),
  });

  assertEquals(response.status, 400);
  assertEquals(await (await getSettings()).json(), { site_name: null });
});
