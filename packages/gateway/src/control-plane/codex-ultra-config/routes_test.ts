import { test } from 'vitest';

import { DEFAULT_CODEX_ULTRA_CONFIG } from '../../data-plane/codex/ultra-config.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('/api/codex-ultra-config GET returns the disabled default', async () => {
  const { adminSession } = await setupAppTest();
  const response = await requestApp('/api/codex-ultra-config', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), DEFAULT_CODEX_ULTRA_CONFIG);
});

test('/api/codex-ultra-config PUT persists an open-string redirect effort', async () => {
  const { adminSession } = await setupAppTest();
  const config = { enabled: true, redirectEffort: 'future-tier' };
  const put = await requestApp('/api/codex-ultra-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify(config),
  });
  assertEquals(put.status, 200);
  assertEquals(await put.json(), config);

  const get = await requestApp('/api/codex-ultra-config', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(await get.json(), config);
});

test('/api/codex-ultra-config rejects an empty redirect effort', async () => {
  const { adminSession } = await setupAppTest();
  const response = await requestApp('/api/codex-ultra-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ enabled: true, redirectEffort: '' }),
  });
  assertEquals(response.status, 400);
});
