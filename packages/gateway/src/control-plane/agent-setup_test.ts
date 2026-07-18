// Gateway-side integration tests for Agent Setup: the wiring the package cannot
// own — public scripts mounted ahead of the logger / CORS / auth middleware,
// control routes behind auth, and the opaque-error boundary. The lease
// lifecycle and multi-page semantics are covered in the package's own tests.

import { expect, test, vi } from 'vitest';

import { getRepo } from '../repo/index.ts';
import type { ApiKey } from '../repo/types.ts';
import { requestApp, setupAppTest } from '../test-helpers.ts';
import { assertEquals } from '@floway-dev/test-utils';

const RAW_KEY = 'raw-key';

const testApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_primary',
  userId: 2,
  name: 'Primary key',
  key: RAW_KEY,
  serverSecret: '00'.repeat(32),
  createdAt: '2026-03-15T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  ...overrides,
});

interface LeaseResponse {
  status: string;
  token: string;
  scripts: { claude: { sh: string; ps1: string }; codex: { sh: string; ps1: string } };
}

const createLease = async (apiKey: ApiKey): Promise<LeaseResponse> => {
  const response = await requestApp('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ apiKeyId: apiKey.id }),
  });
  assertEquals(response.status, 200);
  return (await response.json()) as LeaseResponse;
};

test('control routes require authentication', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const response = await requestApp('/api/setup', { method: 'POST' });
  assertEquals(response.status, 401);
});

test('an unsupported method on a token-shaped path is contained before auth and logging', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const token = 'a'.repeat(43);
  const logged: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await requestApp(`/api/setup/${token}/claude.sh`, { method: 'POST' });
    assertEquals(response.status, 404);
    assertEquals(response.headers.get('cache-control'), 'no-store');
  } finally {
    logSpy.mockRestore();
  }
  expect(logged.join('\n')).not.toContain(token);
});

test('the public GET serves the rendered script with hardened headers and no CORS, requiring no auth', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);

  const response = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(response.headers.get('access-control-allow-origin'), null);
  const text = await response.text();
  expect(text).toContain("SETUP_API_KEY='raw-key'");
  expect(text).toContain("SETUP_API_KEY_NAME='Primary key'");
  expect(text).toContain('Floway Agent Setup common installer fragment (Bash 3.2+)');
  expect(text).toContain('Claude Code Agent Setup fragment.');
  expect(text).not.toContain('Codex Agent Setup fragment.');
});

test('HEAD validates without assembling the API-key body', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  const response = await requestApp(lease.scripts.claude.sh, { method: 'HEAD' });
  assertEquals(response.status, 200);
  assertEquals(await response.text(), '');
});

test('a bogus token is a generic 404 with an empty body and no auth challenge', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const response = await requestApp(`/api/setup/${'a'.repeat(43)}/claude.sh`, { method: 'GET' });
  assertEquals(response.status, 404);
  assertEquals(await response.text(), '');
});

test('the public script route is mounted ahead of the logger, so the lease token never reaches a log line', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);

  const logged: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  } finally {
    logSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).not.toContain(lease.token);
  // The route returns before the logger middleware runs, so there is no
  // completion line for it at all.
  expect(joined).not.toContain('/api/setup/');
});

test('OPTIONS on a script path is contained without resolving the lease or exposing CORS', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  const repo = getRepo();

  const findByTokenSpy = vi.spyOn(repo.agentSetup, 'findByToken');
  const preflight = await requestApp(lease.scripts.claude.sh, {
    method: 'OPTIONS',
    headers: { origin: 'https://cross.example', 'access-control-request-method': 'GET' },
  });
  assertEquals(preflight.status, 404);
  assertEquals(preflight.headers.get('access-control-allow-origin'), null);
  assertEquals(preflight.headers.get('cache-control'), 'no-store');
  expect(findByTokenSpy).not.toHaveBeenCalled();
  findByTokenSpy.mockRestore();

  const get = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  assertEquals(get.headers.get('access-control-allow-origin'), null);
});

test('a public-serve failure is sealed to an opaque 500 that leaks neither token nor secret', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  const repo = getRepo();

  const injectedSecret = 'INJECTED-SECRET-sk-abcdef0123456789';
  repo.agentSetup.findByToken = () => { throw new Error(`forced failure leaking ${lease.token} and ${injectedSecret}`); };

  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
    assertEquals(response.status, 500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
    expect(raw).not.toContain(lease.token);
    expect(raw).not.toContain(injectedSecret);
  } finally {
    errorSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).not.toContain(lease.token);
  expect(joined).not.toContain(injectedSecret);
  expect(joined).not.toContain('forced failure');
});

test('an ordinary control-route internal error still surfaces the full stack trace', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const repo = getRepo();
  repo.agentSetup.insertForUser = () => { throw new Error('ordinary-route-boom'); };

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await requestApp('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ apiKeyId: apiKey.id }),
    });
    assertEquals(response.status, 500);
    const body = (await response.json()) as { error: { type: string; message: string; stack: string; path: string } };
    assertEquals(body.error.type, 'internal_error');
    assertEquals(body.error.message, 'ordinary-route-boom');
    expect(body.error.stack).toContain('ordinary-route-boom');
    assertEquals(body.error.path, '/api/setup');
  } finally {
    errorSpy.mockRestore();
  }
});
