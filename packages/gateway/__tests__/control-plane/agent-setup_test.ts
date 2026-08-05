// Gateway-side integration tests for Agent Setup: the wiring the package cannot
// own — public scripts mounted ahead of the logger / CORS / auth middleware,
// control routes behind auth, and the opaque-error boundary. The lease
// lifecycle and multi-page semantics are covered in the package's own tests.

import { expect, test, vi } from 'vitest';

import { getRepo } from '../../src/repo/index.ts';
import type { ApiKey } from '../../src/repo/types.ts';
import { requestApp, setupAppTest } from '../test-utils/app.ts';
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
  responsesRetentionSeconds: 0,
  ...overrides,
});

interface LeaseResponse {
  status: string;
  token: string;
  scripts: { claude: { sh: string; ps1: string }; codex: { sh: string; ps1: string } };
}

type AppTestContext = Awaited<ReturnType<typeof setupAppTest>>;

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

test('control acquisition rejects foreign and soft-deleted API keys without creating a lease', async () => {
  const { repo, apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const foreign = testApiKey({ id: 'key_foreign', userId: 1, name: 'Foreign key', key: 'foreign-raw' });
  const deleted = testApiKey({
    id: 'key_deleted',
    name: 'Deleted key',
    key: 'deleted-raw',
    deletedAt: '2026-08-06T00:00:00.000Z',
  });
  await repo.apiKeys.save(foreign);
  await repo.apiKeys.save(deleted);

  for (const apiKeyId of [foreign.id, deleted.id]) {
    const response = await requestApp('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ apiKeyId }),
    });
    assertEquals(response.status, 400);
    expect(await response.json()).toEqual({ error: 'The selected API key is not available on your account.' });
  }
  expect(await repo.agentSetup.latestByUserId(apiKey.userId)).toBeNull();
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
});

test('public serving resolves the current key name and secret on every request', async () => {
  const { repo, apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  await repo.apiKeys.save({ ...apiKey, name: 'Rotated key', key: 'rotated-raw-key' });

  const response = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  assertEquals(response.status, 200);
  const text = await response.text();
  expect(text).toContain("SETUP_API_KEY='rotated-raw-key'");
  expect(text).toContain("SETUP_API_KEY_NAME='Rotated key'");
  expect(text).not.toContain("SETUP_API_KEY='raw-key'");
});

const publicLeaseInvalidations = [
  {
    label: 'the API key is deleted',
    apply: async ({ repo, apiKey }: AppTestContext) => { await repo.apiKeys.softDelete(apiKey.id); },
  },
  {
    label: 'the API key moves to another owner',
    apply: async ({ repo, apiKey }: AppTestContext) => { await repo.apiKeys.save({ ...apiKey, userId: 1 }); },
  },
  {
    label: 'the lease owner is deleted',
    apply: async ({ repo, apiKey }: AppTestContext) => { await repo.users.softDelete(apiKey.userId); },
  },
] as const;

test.each(publicLeaseInvalidations)('public serving becomes a generic 404 after $label', async ({ apply }) => {
  const context = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(context.apiKey);
  await apply(context);

  const response = await requestApp(lease.scripts.claude.sh, { method: 'GET' });
  assertEquals(response.status, 404);
  assertEquals(await response.text(), '');
});

test('a bogus token is a generic 404 with an empty body and no auth challenge', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const response = await requestApp(`/api/setup/${'a'.repeat(43)}/claude.sh`, { method: 'GET' });
  assertEquals(response.status, 404);
  assertEquals(response.headers.get('www-authenticate'), null);
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
});

test('a hostile public-serve error cannot escape into the detailed gateway error boundary', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  const repo = getRepo();

  const injectedSecret = 'INJECTED-SECRET-sk-abcdef0123456789';
  const hostile = new Error('safe message');
  Object.defineProperty(hostile, 'stack', { get: () => { throw new Error(injectedSecret); } });
  repo.agentSetup.findByToken = () => { throw hostile; };

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
  expect(logged).toEqual(['Agent Setup: failed to serve a public setup script']);
  expect(joined).not.toContain(lease.token);
  expect(joined).not.toContain(injectedSecret);
});

test('a different authenticated user cannot heartbeat another user\'s lease', async () => {
  const { repo, apiKey, adminSession } = await setupAppTest({ apiKey: testApiKey() });
  const lease = await createLease(apiKey);
  const before = await repo.agentSetup.findByToken(lease.token);

  const response = await requestApp('/api/setup/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ token: lease.token }),
  });
  assertEquals(response.status, 409);
  expect(await response.json()).toEqual({ status: 'missing' });
  expect(await repo.agentSetup.findByToken(lease.token)).toEqual(before);
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
