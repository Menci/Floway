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

test('/api/codex-ultra-config PUT persists the switch', async () => {
  const { adminSession } = await setupAppTest();
  const config = { enabled: true };
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

test('/api/codex-ultra-config rejects unknown fields', async () => {
  const { adminSession } = await setupAppTest();
  const response = await requestApp('/api/codex-ultra-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ enabled: true, extra: true }),
  });
  assertEquals(response.status, 400);
});
