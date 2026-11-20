import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

const getSettings = (headers: Record<string, string> = {}) =>
  requestApp('/api/site-settings', { headers });

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
