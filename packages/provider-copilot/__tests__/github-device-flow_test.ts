import { test } from 'vitest';

import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../src/github-device-flow.ts';
import type { Fetcher, FetchInit } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse } from '@floway-dev/test-utils';

const requestParameters = (init: FetchInit): URLSearchParams => {
  assertEquals(init.method, 'POST');
  assertEquals(init.redirect, 'manual');
  const headers = new Headers(init.headers);
  assertEquals(headers.get('accept'), 'application/json');
  assertEquals(headers.get('content-type'), 'application/x-www-form-urlencoded;charset=UTF-8');
  return new URLSearchParams(String(init.body));
};

test('startGitHubDeviceFlow sends the OAuth form request through the supplied fetcher', async () => {
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

  assertEquals(await startGitHubDeviceFlow('github.com', fetcher), {
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
  assertEquals(await startGitHubDeviceFlow('github.com', fetcher), {
    ok: false,
    error: 'GitHub error: temporarily unavailable',
  });
});

test('startGitHubDeviceFlow rejects malformed and incomplete success bodies', async () => {
  await assertRejects(
    () => startGitHubDeviceFlow('github.com', async () => jsonResponse({ user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })),
    Error,
    'device_code',
  );
  await assertRejects(
    () => startGitHubDeviceFlow('github.com', async () => jsonResponse({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900 })),
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

  assertEquals(await pollGitHubDeviceFlow('github.com', 'device-live', fetcher), {
    access_token: 'ghu_live',
    token_type: 'bearer',
    scope: 'read:user',
  });
  assertEquals(called, true);
});

test.each([
  { error: 'authorization_pending' },
  {
    error: 'slow_down',
    error_description: 'Too many requests have been made in the same timeframe.',
    interval: 10,
  },
  { error: 'access_denied', error_description: 'The user has rejected authorization.' },
])('pollGitHubDeviceFlow preserves GitHub HTTP 200 $error', async body => {
  assertEquals(await pollGitHubDeviceFlow('github.com', 'device', async () => jsonResponse(body)), body);
});

test('pollGitHubDeviceFlow preserves conforming HTTP 400 OAuth errors', async () => {
  const body = { error: 'expired_token', error_description: 'The device code has expired.' };
  assertEquals(await pollGitHubDeviceFlow('github.com', 'device', async () => jsonResponse(body, 400)), body);
});

test('pollGitHubDeviceFlow rejects malformed token and HTTP responses', async () => {
  await assertRejects(
    () => pollGitHubDeviceFlow('github.com', 'device', async () => jsonResponse({ access_token: 'ghu_missing_type' })),
    Error,
    'token_type',
  );
  await assertRejects(
    () => pollGitHubDeviceFlow('github.com', 'device', async () => new Response('bad gateway', { status: 502 })),
    Error,
    'unexpected HTTP status code',
  );
});
