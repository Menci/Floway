import { test } from 'vitest';

import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../src/github-device-flow.ts';
import type { Fetcher } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse } from '@floway-dev/test-utils';

const requestParameters = (init: RequestInit): URLSearchParams => {
  assertEquals(init.method, 'POST');
  assertEquals(init.redirect, 'manual');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('accept'), 'application/json');
  assertEquals(headers.get('content-type'), 'application/x-www-form-urlencoded;charset=UTF-8');
  return new URLSearchParams(String(init.body));
};

test('startGitHubDeviceFlow sends the probed form request through the supplied fetcher', async () => {
  let called = false;
  const fetcher: Fetcher = async (url, init) => {
    called = true;
    assertEquals(url, 'https://github.com/login/device/code');
    const parameters = requestParameters(init);
    assertEquals(parameters.get('client_id'), 'Iv1.b507a08c87ecfe98');
    assertEquals(parameters.get('scope'), 'read:user');
    return jsonResponse({
      device_code: 'device-live',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device',
      expires_in: 899,
      interval: 5,
    });
  };

  assertEquals(await startGitHubDeviceFlow(fetcher), {
    ok: true,
    data: {
      device_code: 'device-live',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device',
      expires_in: 899,
      interval: 5,
    },
  });
  assertEquals(called, true);
});

test('startGitHubDeviceFlow preserves the existing HTTP error result', async () => {
  const fetcher: Fetcher = async () => new Response('temporarily unavailable', { status: 503 });
  assertEquals(await startGitHubDeviceFlow(fetcher), {
    ok: false,
    error: 'GitHub error: temporarily unavailable',
  });
});

test('startGitHubDeviceFlow rejects malformed and incomplete success bodies', async () => {
  await assertRejects(
    () => startGitHubDeviceFlow(async () => jsonResponse({ user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })),
    Error,
    'device_code',
  );
  await assertRejects(
    () => startGitHubDeviceFlow(async () => jsonResponse({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900 })),
    Error,
    'missing interval',
  );
});

test('pollGitHubDeviceFlow sends the device grant through the supplied fetcher', async () => {
  let called = false;
  const fetcher: Fetcher = async (url, init) => {
    called = true;
    assertEquals(url, 'https://github.com/login/oauth/access_token');
    const parameters = requestParameters(init);
    assertEquals(parameters.get('client_id'), 'Iv1.b507a08c87ecfe98');
    assertEquals(parameters.get('device_code'), 'device-live');
    assertEquals(parameters.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    return jsonResponse({ access_token: 'ghu_live', token_type: 'bearer', scope: 'read:user' });
  };

  assertEquals(await pollGitHubDeviceFlow('device-live', fetcher), {
    access_token: 'ghu_live',
    token_type: 'bearer',
    scope: 'read:user',
  });
  assertEquals(called, true);
});

test('pollGitHubDeviceFlow preserves GitHub HTTP 200 authorization_pending', async () => {
  const fetcher: Fetcher = async () => jsonResponse({ error: 'authorization_pending' });
  assertEquals(await pollGitHubDeviceFlow('device', fetcher), { error: 'authorization_pending' });
});

test('pollGitHubDeviceFlow preserves slow_down and terminal OAuth errors', async () => {
  const slowDown = {
    error: 'slow_down',
    error_description: 'Too many requests have been made in the same timeframe.',
    interval: 10,
  };
  assertEquals(
    await pollGitHubDeviceFlow('device', async () => jsonResponse(slowDown, 400)),
    slowDown,
  );

  const denied = { error: 'access_denied', error_description: 'The user has rejected authorization.' };
  assertEquals(
    await pollGitHubDeviceFlow('device', async () => jsonResponse(denied, 400)),
    denied,
  );
});

test('pollGitHubDeviceFlow rejects malformed token and HTTP responses', async () => {
  await assertRejects(
    () => pollGitHubDeviceFlow('device', async () => jsonResponse({ access_token: 'ghu_missing_type' })),
    Error,
    'token_type',
  );
  await assertRejects(
    () => pollGitHubDeviceFlow('device', async () => new Response('bad gateway', { status: 502 })),
    Error,
    'unexpected HTTP response status code',
  );
});
