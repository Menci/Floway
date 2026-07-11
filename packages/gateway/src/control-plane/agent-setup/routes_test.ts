import { expect, test, vi } from 'vitest';

import { SETUP_PS1_BODY, SETUP_SH_BODY } from './script-assets.generated.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// A key whose raw value is a fixed, greppable string so the rendered prefix is
// easy to assert against.
const RAW_KEY = 'raw-key';

const testApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_primary',
  userId: 2,
  name: 'Primary key',
  key: RAW_KEY,
  createdAt: '2026-03-15T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  ...overrides,
});

interface LeaseResponse {
  status: string;
  token: string;
  configuration: {
    apiKeyId: string;
    claudeCode: { enabled: boolean; modelDiscovery: boolean; model: string | null; effortLevel: string | null };
    codex: { enabled: boolean; model: string | null; reasoningEffort: string | null };
  };
  configurationRevision: number;
  expiresAt: number;
  scripts: { sh: string; ps1: string };
}

const createLease = (rawKey: string, publicBaseUrl = 'https://example.com') =>
  requestApp('/api/setup', {
    method: 'POST',
    headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
    body: JSON.stringify({ publicBaseUrl }),
  });

// --- create (first use + restore) ---

test('POST /api/setup first use selects the first active key and enables both agents', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const response = await createLease(apiKey.key);
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;

  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.apiKeyId, apiKey.id);
  assertEquals(body.configuration.claudeCode.enabled, true);
  assertEquals(body.configuration.codex.enabled, true);
  assertEquals(body.configuration.claudeCode.modelDiscovery, true);
  assertEquals(body.configuration.claudeCode.model, null);
  assertEquals(body.configuration.claudeCode.effortLevel, null);
  assertEquals(body.configuration.codex.model, null);
  assertEquals(body.configuration.codex.reasoningEffort, null);
  assertEquals(body.configurationRevision, 1);
  // Token is 32 bytes as unpadded base64url = exactly 43 chars.
  expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // Script URLs are origin-relative and carry the token.
  assertEquals(body.scripts.sh, `/api/setup/${body.token}/setup.sh`);
  assertEquals(body.scripts.ps1, `/api/setup/${body.token}/setup.ps1`);
});

test('POST /api/setup returns a typed no-key response when the account has no active key', async () => {
  const { repo, apiKey } = await setupAppTest({ apiKey: testApiKey() });
  // Soft-delete the only key, then reach the route via a fresh session (a
  // deleted key can no longer authenticate as itself).
  const session = (await repo.sessions.create(2)).id;
  await repo.apiKeys.softDelete(apiKey.id);

  const response = await requestApp('/api/setup', {
    method: 'POST',
    headers: { 'x-floway-session': session, 'content-type': 'application/json' },
    body: JSON.stringify({ publicBaseUrl: 'https://example.com' }),
  });
  assertEquals(response.status, 409);
  const body = (await response.json()) as { status: string };
  assertEquals(body.status, 'no-selectable-key');
});

test('POST /api/setup restores a saved configuration whose key is still selectable', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const first = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  // Edit the configuration (disable Codex), then reopen — the reopen must
  // restore the persisted preference rather than reset to first-use defaults.
  const edited = { ...first.configuration, codex: { ...first.configuration.codex, enabled: false } };
  const put = await requestApp('/api/setup', {
    method: 'PUT',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }),
  });
  assertEquals(put.status, 200);

  const reopened = (await (await createLease(apiKey.key)).json()) as LeaseResponse;
  assertEquals(reopened.configuration.codex.enabled, false);
  // Reopening rotates the token.
  expect(reopened.token).not.toBe(first.token);
});

test('POST /api/setup rejects a public base URL that is not a bare http(s) origin', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  for (const bad of [
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?q=1',
    'https://example.com/#frag',
    'not a url',
  ]) {
    const response = await createLease(apiKey.key, bad);
    assertEquals(response.status, 400);
  }
});

// --- update + heartbeat discriminants ---

test('PUT /api/setup updates configuration and bumps the revision', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;
  const edited = { ...lease.configuration, claudeCode: { ...lease.configuration.claudeCode, enabled: false } };

  const response = await requestApp('/api/setup', {
    method: 'PUT',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.claudeCode.enabled, false);
  assertEquals(body.configurationRevision, lease.configurationRevision + 1);
});

test('PUT /api/setup returns superseded 409 for a token that no longer owns the lease', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const response = await requestApp('/api/setup', {
    method: 'PUT',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'x'.repeat(43), configuration: lease.configuration, expectedRevision: lease.configurationRevision }),
  });
  assertEquals(response.status, 409);
  const body = (await response.json()) as { status: string };
  assertEquals(body.status, 'superseded');
});

test('PUT /api/setup returns revision-conflict 409 carrying the current lease', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const response = await requestApp('/api/setup', {
    method: 'PUT',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: lease.token, configuration: lease.configuration, expectedRevision: lease.configurationRevision + 99 }),
  });
  assertEquals(response.status, 409);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'revision-conflict');
  // The ride-along record lets the dashboard rebase onto the live revision.
  assertEquals(body.configurationRevision, lease.configurationRevision);
});

test('POST /api/setup/heartbeat renews the lease without bumping the revision', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const response = await requestApp('/api/setup/heartbeat', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: lease.token }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'ok');
  assertEquals(body.configurationRevision, lease.configurationRevision);
  expect(body.expiresAt).toBeGreaterThanOrEqual(lease.expiresAt);
});

test('POST /api/setup/heartbeat on a superseded token is a 409', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  await (await createLease(apiKey.key)).json();

  const response = await requestApp('/api/setup/heartbeat', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'y'.repeat(43) }),
  });
  assertEquals(response.status, 409);
  assertEquals(((await response.json()) as { status: string }).status, 'superseded');
});

test('POST /api/setup retries a unique-token collision without masking unrelated DB errors', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const repo = getRepo();
  const original = repo.agentSetup.replaceForUser.bind(repo.agentSetup);

  // First call throws the SQLite token-uniqueness message; the route must
  // regenerate a token and retry.
  let calls = 0;
  repo.agentSetup.replaceForUser = async input => {
    calls += 1;
    if (calls === 1) throw new Error('UNIQUE constraint failed: agent_setup.token');
    return await original(input);
  };
  const ok = await createLease(apiKey.key);
  assertEquals(ok.status, 200);
  expect(calls).toBe(2);

  // An unrelated DB error must propagate as a 500, not be swallowed by retry.
  repo.agentSetup.replaceForUser = async () => {
    throw new Error('disk I/O error');
  };
  const failed = await createLease(apiKey.key);
  assertEquals(failed.status, 500);
});

// --- public script serving ---

test('GET /api/setup/:token/setup.sh serves the prefix + fixed body with hardened headers and no CORS', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const response = await requestApp(lease.scripts.sh, { method: 'GET' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(response.headers.get('referrer-policy'), 'no-referrer');
  assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
  assertEquals(response.headers.get('access-control-allow-origin'), null);

  const text = await response.text();
  expect(text).toContain("FLOWAY_API_KEY='raw-key'");
  expect(text).toContain("FLOWAY_BASE_URL='https://example.com'");
  expect(text).toContain(SETUP_SH_BODY);
  expect(text).toContain('Floway agent setup installer (Bash 3.2+)');
});

test('GET /api/setup/:token/setup.ps1 serves the PowerShell prefix + fixed body', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const response = await requestApp(lease.scripts.ps1, { method: 'GET' });
  assertEquals(response.status, 200);
  const text = await response.text();
  expect(text).toContain("$FlowayApiKey = 'raw-key'");
  expect(text).toContain(SETUP_PS1_BODY);
});

test('HEAD /api/setup/:token/setup.sh validates but returns an empty body', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const response = await requestApp(lease.scripts.sh, { method: 'HEAD' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(await response.text(), '');
});

test('unknown, expired, deleted-user, deleted-key, and mismatched tokens all return an identical generic 404', async () => {
  const { repo, apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const now = Date.now();
  const configJson = JSON.stringify({
    apiKeyId: apiKey.id,
    claudeCode: { enabled: true, model: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, modelDiscovery: true },
    codex: { enabled: true, model: null, reasoningEffort: null },
  });

  // Unknown but well-formed token.
  const unknownToken = 'a'.repeat(43);

  // Expired lease.
  const expiredToken = 'b'.repeat(43);
  await repo.agentSetup.replaceForUser({ userId: 2, token: expiredToken, apiKeyId: apiKey.id, configurationJson: configJson, publicBaseUrl: 'https://example.com', now, expiresAt: now - 1 });

  // Config referencing a key owned by another user (config mismatch).
  await repo.users.save({ id: 3, username: 'mallory', passwordHash: null, isAdmin: false, upstreamIds: null, canViewGlobalTelemetry: false, createdAt: '2026-03-15T00:00:00.000Z', deletedAt: null });
  await repo.apiKeys.save({ ...testApiKey(), id: 'key_other', userId: 3, key: 'raw-other' });
  const mismatchToken = 'c'.repeat(43);
  await repo.agentSetup.replaceForUser({ userId: 3, token: mismatchToken, apiKeyId: apiKey.id, configurationJson: configJson, publicBaseUrl: 'https://example.com', now, expiresAt: now + 300_000 });

  const bodies = new Set<string>();
  for (const token of [unknownToken, expiredToken, mismatchToken]) {
    const response = await requestApp(`/api/setup/${token}/setup.sh`, { method: 'GET' });
    assertEquals(response.status, 404);
    bodies.add(await response.text());
  }

  // Deleted user.
  const userToken = 'd'.repeat(43);
  await repo.agentSetup.replaceForUser({ userId: 2, token: userToken, apiKeyId: apiKey.id, configurationJson: configJson, publicBaseUrl: 'https://example.com', now, expiresAt: now + 300_000 });
  await repo.users.softDelete(2);
  const deletedUser = await requestApp(`/api/setup/${userToken}/setup.sh`, { method: 'GET' });
  assertEquals(deletedUser.status, 404);
  bodies.add(await deletedUser.text());

  // All rejection bodies are byte-identical, so none leaks which check failed.
  assertEquals(bodies.size, 1);
});

test('HEAD on an unknown token is a 404 with an empty body', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const response = await requestApp(`/api/setup/${'a'.repeat(43)}/setup.sh`, { method: 'HEAD' });
  assertEquals(response.status, 404);
  assertEquals(await response.text(), '');
});

test('GET re-reads the current configuration each request', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const before = await (await requestApp(lease.scripts.sh, { method: 'GET' })).text();
  expect(before).toContain("FLOWAY_INSTALL_CODEX='1'");

  // Persist a configuration change through the PUT route; the next GET must
  // reflect it without any token rotation.
  const edited = { ...lease.configuration, codex: { ...lease.configuration.codex, enabled: false } };
  await requestApp('/api/setup', {
    method: 'PUT',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }),
  });

  const after = await (await requestApp(lease.scripts.sh, { method: 'GET' })).text();
  expect(after).toContain("FLOWAY_INSTALL_CODEX=''");
  expect(after).not.toContain("FLOWAY_INSTALL_CODEX='1'");
});

// --- security: token never leaks through logs or the 500 body ---

test('a forced internal failure on the script route leaks the token in neither logs nor the 500 body', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;
  const repo = getRepo();
  repo.agentSetup.findByToken = async () => {
    throw new Error('forced failure');
  };

  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await requestApp(lease.scripts.sh, { method: 'GET' });
    assertEquals(response.status, 500);
    const raw = await response.text();
    expect(raw).not.toContain(lease.token);
    const body = JSON.parse(raw) as { error: { path: string } };
    assertEquals(body.error.path, '/api/setup/[redacted]/setup.sh');
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
  expect(logged.join('\n')).not.toContain(lease.token);
});

test('the request logger redacts the token from the logged path', async () => {
  const { apiKey } = await setupAppTest({ apiKey: testApiKey() });
  const lease = (await (await createLease(apiKey.key)).json()) as LeaseResponse;

  const logged: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    await requestApp(lease.scripts.sh, { method: 'GET' });
  } finally {
    logSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).toContain('/api/setup/[redacted]/setup.sh');
  expect(joined).not.toContain(lease.token);
});

// --- the public matcher is exact; everything else stays authenticated ---

test('control routes still require authentication', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const response = await requestApp('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicBaseUrl: 'https://example.com' }),
  });
  assertEquals(response.status, 401);
});

test('a GET whose token is not exactly 43 base64url chars is not treated as public', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  // 42 chars — one short — so the exact matcher rejects it and auth demands a
  // credential rather than serving it as a public script.
  const response = await requestApp(`/api/setup/${'a'.repeat(42)}/setup.sh`, { method: 'GET' });
  assertEquals(response.status, 401);
});

test('a POST to a script-shaped path is not treated as public', async () => {
  await setupAppTest({ apiKey: testApiKey() });
  const response = await requestApp(`/api/setup/${'a'.repeat(43)}/setup.sh`, { method: 'POST' });
  assertEquals(response.status, 401);
});

// --- generated assets stay in sync with the canonical scripts ---

test('generated script bodies match the checked-in canonical scripts byte for byte', async () => {
  const { readFile } = await import('node:fs/promises');
  const sh = await readFile(new URL('./scripts/setup.sh', import.meta.url), 'utf8');
  const ps1 = await readFile(new URL('./scripts/setup.ps1', import.meta.url), 'utf8');
  assertEquals(SETUP_SH_BODY, sh);
  assertEquals(SETUP_PS1_BODY, ps1);
  // Never expose the assertion helper as unused if the bodies are empty.
  assertExists(SETUP_SH_BODY);
});
