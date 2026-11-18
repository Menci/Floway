import { test } from 'vitest';

import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../src/github-device-flow.ts';
import { assertEquals, assertRejects, jsonResponse } from '@floway-dev/test-utils';

test('startGitHubDeviceFlow rejects a success body without a polling interval', async () => {
  await assertRejects(
    () => startGitHubDeviceFlow('github.com', async () => jsonResponse({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900 })),
    Error,
    'missing interval',
  );
});

test('pollGitHubDeviceFlow preserves a GitHub HTTP 200 OAuth error', async () => {
  const body = {
    error: 'slow_down',
    error_description: 'Too many requests have been made in the same timeframe.',
    interval: 10,
  };
  assertEquals(await pollGitHubDeviceFlow('github.com', 'device', async () => jsonResponse(body)), body);
});
