// Domain tests for the Agent Setup route factories, driven against an in-memory
// fake repository and injected dependency callbacks — no HTTP auth, CORS, or
// logger. Those host concerns are exercised where they live (the gateway
// integration test); here we prove the multi-lease lifecycle, the optimistic-
// concurrency discriminants, and the sealed public serve path.

import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { type AgentSetupMutation, type AgentSetupRecord, type AgentSetupRenewal, type AgentSetupRepository, AgentSetupTokenCollisionError } from './repository.ts';
import {
  type AgentSetupControlDeps,
  type AgentSetupPublicDeps,
  createAgentSetupControlRoutes,
  createAgentSetupPublicRoutes,
} from './routes.ts';
import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON_HELPERS,
  SETUP_BASH_COMMON_MAIN,
  SETUP_BASH_COMMON_OUTPUT,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON_HELPERS,
  SETUP_POWERSHELL_COMMON_MAIN,
  SETUP_POWERSHELL_COMMON_OUTPUT,
} from './script-assets.generated.ts';
import { SETUP_SCRIPT_BODIES } from './script-assets.ts';
import { assertEquals } from '@floway-dev/test-utils';

const RAW_KEY = 'raw-key';
const USER_ID = 2;
const BASH_COMMON = SETUP_BASH_COMMON_OUTPUT + SETUP_BASH_COMMON_HELPERS + SETUP_BASH_COMMON_MAIN;
const POWERSHELL_COMMON = SETUP_POWERSHELL_COMMON_OUTPUT + SETUP_POWERSHELL_COMMON_HELPERS + SETUP_POWERSHELL_COMMON_MAIN;

// A faithful multi-row fake: token is the key, rows accrete, latest-by-user is
// deterministic, and insert sweeps only the same user's already-expired rows.
class FakeAgentSetupRepository implements AgentSetupRepository {
  readonly rows = new Map<string, AgentSetupRecord>();

  findByToken(token: string): Promise<AgentSetupRecord | null> {
    const row = this.rows.get(token);
    return Promise.resolve(row ? { ...row } : null);
  }

  latestByUserId(userId: number): Promise<AgentSetupRecord | null> {
    const owned = [...this.rows.values()]
      .filter(row => row.userId === userId)
      .sort((a, b) =>
        b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.token < b.token ? 1 : -1));
    return Promise.resolve(owned[0] ? { ...owned[0] } : null);
  }

  insertForUser(input: {
    userId: number; token: string; configurationJson: string; now: number; expiresAt: number;
  }): Promise<AgentSetupRecord> {
    if (this.rows.has(input.token)) throw new AgentSetupTokenCollisionError();
    const record: AgentSetupRecord = {
      token: input.token,
      userId: input.userId,
      configurationJson: input.configurationJson,
      configurationRevision: 1,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.rows.set(record.token, record);
    for (const [token, row] of this.rows) {
      if (row.userId === input.userId && token !== record.token && row.expiresAt <= input.now) this.rows.delete(token);
    }
    return Promise.resolve({ ...record });
  }

  updateConfiguration(input: {
    userId: number; token: string; expectedRevision: number; configurationJson: string; now: number; expiresAt: number;
  }): Promise<AgentSetupMutation> {
    const row = this.rows.get(input.token);
    if (!row || row.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    if (row.configurationRevision !== input.expectedRevision) return Promise.resolve({ status: 'revision-conflict', record: { ...row } });
    const updated: AgentSetupRecord = {
      ...row,
      configurationJson: input.configurationJson,
      configurationRevision: row.configurationRevision + 1,
      expiresAt: input.expiresAt,
      updatedAt: input.now,
    };
    this.rows.set(updated.token, updated);
    return Promise.resolve({ status: 'ok', record: { ...updated } });
  }

  renewLease(input: { userId: number; token: string; expiresAt: number }): Promise<AgentSetupRenewal> {
    const row = this.rows.get(input.token);
    if (!row || row.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    const updated: AgentSetupRecord = { ...row, expiresAt: input.expiresAt };
    this.rows.set(updated.token, updated);
    return Promise.resolve({ status: 'ok', record: { ...updated } });
  }
}

interface Harness {
  repo: FakeAgentSetupRepository;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

// keys maps a userId to its selectable key ids (priority order); secrets maps a
// key id to its raw value, gating public serve on ownership + existence.
const harness = (options: {
  routePath?: string;
  keys?: readonly string[];
  secrets?: Record<string, string>;
  users?: readonly number[];
  publicOverrides?: Partial<AgentSetupPublicDeps>;
  controlOverrides?: Partial<AgentSetupControlDeps<Record<never, never>>>;
} = {}): Harness => {
  const repo = new FakeAgentSetupRepository();
  const routePath = options.routePath ?? '/api/setup';
  const keys = options.keys ?? ['key_primary'];
  const secrets = options.secrets ?? { key_primary: RAW_KEY };
  const users = new Set(options.users ?? [USER_ID]);

  const publicDeps: AgentSetupPublicDeps = {
    repository: repo,
    userExists: userId => Promise.resolve(users.has(userId)),
    resolveApiKey: (_userId, apiKeyId) => Promise.resolve(
      secrets[apiKeyId] === undefined ? null : { name: apiKeyId === 'key_primary' ? 'Primary key' : apiKeyId, secret: secrets[apiKeyId] },
    ),
    ...options.publicOverrides,
  };
  const controlDeps = {
    repository: repo,
    publicScriptBasePath: routePath,
    getUserId: () => USER_ID,
    listSelectableApiKeyIds: () => Promise.resolve(keys),
    ...options.controlOverrides,
  } satisfies AgentSetupControlDeps<Record<never, never>> & { publicScriptBasePath: string };

  const app = new Hono()
    .route(routePath, createAgentSetupPublicRoutes(publicDeps))
    .route(routePath, createAgentSetupControlRoutes(controlDeps));

  return { repo, request: (path, init) => app.request(path, init ?? {}) as Promise<Response> };
};

interface LeaseResponse {
  status: string;
  token: string;
  configuration: {
    apiKeyId: string;
    claudeCode: { modelDiscovery: boolean; model: string | null; effortLevel: string | null; cleanupPeriodDays: number | null; optOutAiAttribution: boolean };
    codex: { model: string | null; reasoningEffort: string | null };
  };
  configurationRevision: number;
  expiresAt: number;
  scripts: {
    claude: { sh: string; ps1: string };
    codex: { sh: string; ps1: string };
  };
}

// A full, schema-valid configuration for rows seeded directly into the repo
// (leaseProjection and restore both parse the stored JSON through the schema).
const FULL_CONFIG_JSON = (apiKeyId: string): string => JSON.stringify({
  apiKeyId,
  claudeCode: { model: null, defaultOpusModel: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: true },
  codex: { model: null, reasoningEffort: null },
});

const putJson = (body: object): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const heartbeatJson = (body: object): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const create = async (h: Harness, apiKeyId = 'key_primary'): Promise<LeaseResponse> => {
  const response = await h.request('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKeyId }),
  });
  assertEquals(response.status, 200);
  return (await response.json()) as LeaseResponse;
};

// --- create: first use, restore, multi-page independence ---

test('POST first use selects the first key and enables both agents at revision 1', async () => {
  const h = harness();
  const body = await create(h);

  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.apiKeyId, 'key_primary');
  assertEquals(body.configuration.claudeCode.modelDiscovery, true);
  assertEquals(body.configuration.claudeCode.model, null);
  assertEquals(body.configuration.claudeCode.cleanupPeriodDays, null);
  assertEquals(body.configuration.claudeCode.optOutAiAttribution, false);
  assertEquals(body.configurationRevision, 1);
  expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  assertEquals(body.scripts.claude.sh, `/api/setup/${body.token}/claude.sh`);
  assertEquals(body.scripts.claude.ps1, `/api/setup/${body.token}/claude.ps1`);
  assertEquals(body.scripts.codex.sh, `/api/setup/${body.token}/codex.sh`);
  assertEquals(body.scripts.codex.ps1, `/api/setup/${body.token}/codex.ps1`);
});

test('POST creates the lease for the requested selectable key', async () => {
  const h = harness({ keys: ['key_primary', 'key_other'], secrets: { key_primary: RAW_KEY, key_other: 'raw-other' } });
  const body = await create(h, 'key_other');
  assertEquals(body.configuration.apiKeyId, 'key_other');
  assertEquals(JSON.parse((await h.repo.findByToken(body.token))!.configurationJson).apiKeyId, 'key_other');
});

test('POST projects scripts from the host-supplied public route path', async () => {
  const h = harness({ routePath: '/custom/agent-setup' });
  const response = await h.request('/custom/agent-setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.scripts.claude.sh, `/custom/agent-setup/${body.token}/claude.sh`);
  assertEquals(body.scripts.codex.ps1, `/custom/agent-setup/${body.token}/codex.ps1`);
});

test('POST returns no-selectable-key when the account has no key', async () => {
  const h = harness({ keys: [] });
  const response = await h.request('/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
  });
  assertEquals(response.status, 409);
  assertEquals(((await response.json()) as { status: string }).status, 'no-selectable-key');
});

test('POST restores the latest saved configuration whose key is still selectable', async () => {
  const h = harness();
  const first = await create(h);
  const edited = { ...first.configuration, codex: { ...first.configuration.codex, reasoningEffort: 'high' } };
  await h.request('/api/setup', putJson({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }));

  const reopened = await create(h);
  assertEquals(reopened.configuration.codex.reasoningEffort, 'high');
  // A reopen inserts a brand-new independent lease; it never reuses a token.
  expect(reopened.token).not.toBe(first.token);
  assertEquals(reopened.configurationRevision, 1);
});

test('POST falls back to a first-use default when the latest config points at an unselectable key', async () => {
  const h = harness();
  const first = await create(h);
  // Persist a configuration whose key later becomes unselectable.
  const edited = { ...first.configuration, apiKeyId: 'key_primary', codex: { ...first.configuration.codex, reasoningEffort: 'high' } };
  await h.request('/api/setup', putJson({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }));

  // Now only a different key is selectable; the saved config cannot be restored.
  const h2 = harness({ keys: ['key_other'], secrets: { key_other: 'raw-other' } });
  // Seed h2's repo with the same saved (unselectable) latest row.
  await h2.repo.insertForUser({ userId: USER_ID, token: 'x'.repeat(43), configurationJson: JSON.stringify(edited), now: Date.now(), expiresAt: Date.now() + 300_000 });
  const reopened = await create(h2, 'key_other');
  assertEquals(reopened.configuration.apiKeyId, 'key_other');
  assertEquals(reopened.configuration.codex.reasoningEffort, null);
});

test('two POSTs coexist as independent leases: neither supersedes the other', async () => {
  const h = harness();
  const a = await create(h);
  const b = await create(h);
  expect(b.token).not.toBe(a.token);
  // Both tokens remain live and independently servable.
  assertEquals((await h.request(`/api/setup/${a.token}/claude.sh`, { method: 'HEAD' })).status, 200);
  assertEquals((await h.request(`/api/setup/${b.token}/codex.sh`, { method: 'HEAD' })).status, 200);
});

test('inserting a new lease sweeps only the same user\'s already-expired rows', async () => {
  const h = harness();
  const now = Date.now();
  // An expired sibling and a still-live sibling.
  await h.repo.insertForUser({ userId: USER_ID, token: 'e'.repeat(43), configurationJson: FULL_CONFIG_JSON('key_primary'), now: now - 10_000, expiresAt: now - 1 });
  const live = await create(h);
  // The expired row is gone; the live rows survive.
  assertEquals(await h.repo.findByToken('e'.repeat(43)), null);
  expect(await h.repo.findByToken(live.token)).not.toBeNull();
});

// --- update + heartbeat discriminants ---

test('PUT updates configuration, bumps the revision, and never rotates the token', async () => {
  const h = harness();
  const lease = await create(h);
  const edited = { ...lease.configuration, claudeCode: { ...lease.configuration.claudeCode, effortLevel: 'high' as const } };
  const response = await h.request('/api/setup', putJson({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }));
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.claudeCode.effortLevel, 'high');
  assertEquals(body.configurationRevision, lease.configurationRevision + 1);
  assertEquals(body.token, lease.token);
});

test('PUT on a token that does not exist is a terminal 409 missing', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request('/api/setup', putJson({ token: 'z'.repeat(43), configuration: lease.configuration, expectedRevision: lease.configurationRevision }));
  assertEquals(response.status, 409);
  assertEquals(((await response.json()) as { status: string }).status, 'missing');
});

test('PUT with a stale revision returns revision-conflict carrying the current lease', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request('/api/setup', putJson({ token: lease.token, configuration: lease.configuration, expectedRevision: lease.configurationRevision + 99 }));
  assertEquals(response.status, 409);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'revision-conflict');
  assertEquals(body.configurationRevision, lease.configurationRevision);
});

test('PUT rejecting an unavailable key returns a 400 that leaks nothing', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request('/api/setup', putJson({
    token: lease.token,
    configuration: { ...lease.configuration, apiKeyId: 'key_foreign' },
    expectedRevision: lease.configurationRevision,
  }));
  assertEquals(response.status, 400);
  const errorBody = (await response.json()) as Record<string, unknown>;
  assertEquals(errorBody.error, 'The selected API key is not available on your account.');
  expect(errorBody).not.toHaveProperty('token');
  expect(JSON.stringify(errorBody)).not.toContain(lease.token);
});

test('heartbeat renews expiry without bumping revision or updated_at', async () => {
  const h = harness();
  const lease = await create(h);
  const before = await h.repo.findByToken(lease.token);
  const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: lease.token }));
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'ok');
  assertEquals(body.configurationRevision, lease.configurationRevision);
  expect(body.expiresAt).toBeGreaterThanOrEqual(lease.expiresAt);
  const after = await h.repo.findByToken(lease.token);
  assertEquals(after!.updatedAt, before!.updatedAt);
});

test('heartbeat on a missing token is a terminal 409 missing', async () => {
  const h = harness();
  await create(h);
  const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: 'q'.repeat(43) }));
  assertEquals(response.status, 409);
  assertEquals(((await response.json()) as { status: string }).status, 'missing');
});

test('heartbeat renews an expired-but-still-present lease', async () => {
  const h = harness();
  const now = Date.now();
  await h.repo.insertForUser({ userId: USER_ID, token: 'p'.repeat(43), configurationJson: FULL_CONFIG_JSON('key_primary'), now: now - 10_000, expiresAt: now - 1 });
  const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: 'p'.repeat(43) }));
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  expect(body.expiresAt).toBeGreaterThan(now);
});

test('POST retries a token collision without masking unrelated failures', async () => {
  const h = harness();
  const original = h.repo.insertForUser.bind(h.repo);
  let calls = 0;
  h.repo.insertForUser = async input => {
    calls += 1;
    if (calls === 1) throw new AgentSetupTokenCollisionError();
    return await original(input);
  };
  const first = await create(h);
  assertEquals(first.status, 'ok');
  expect(calls).toBe(2);

  // An unrelated failure is not a collision, so withFreshToken must not retry
  // it away — it propagates out of the handler (surfaced by Hono as a 500).
  let attempts = 0;
  h.repo.insertForUser = () => { attempts += 1; throw new Error('disk I/O error'); };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const failed = await h.request('/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
    });
    assertEquals(failed.status, 500);
    expect(attempts).toBe(1);
  } finally {
    errorSpy.mockRestore();
  }
});

// --- public serve ---

test('GET serves the shell prefix + common and target-agent fragments with hardened no-store headers', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request(lease.scripts.claude.sh, { method: 'GET' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(response.headers.get('pragma'), 'no-cache');
  assertEquals(response.headers.get('expires'), '0');
  assertEquals(response.headers.get('referrer-policy'), 'no-referrer');
  assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
  const text = await response.text();
  const body = SETUP_SCRIPT_BODIES.claude.sh;
  const prefix = text.slice(0, text.indexOf(body));
  expect(prefix).toContain("SETUP_API_KEY='raw-key'");
  expect(prefix).toContain('SETUP_CLAUDE_');
  expect(prefix).not.toContain('SETUP_CODEX_');
  expect(prefix).not.toContain('SETUP_ENDPOINT');
  expect(text).toContain(body);
  expect(body).toContain(BASH_COMMON);
  expect(body).toContain(SETUP_BASH_CLAUDE);
  expect(body).not.toContain(SETUP_BASH_CODEX);
});

test('GET serves the PowerShell prefix + common and target-agent fragments', async () => {
  const h = harness();
  const lease = await create(h);
  const text = await (await h.request(lease.scripts.codex.ps1, { method: 'GET' })).text();
  const body = SETUP_SCRIPT_BODIES.codex.ps1;
  const prefix = text.slice(0, text.indexOf(body));
  expect(prefix).toContain("$SetupApiKey = 'raw-key'");
  expect(prefix).toContain('$SetupCodex');
  expect(prefix).not.toContain('$SetupClaude');
  expect(text).toContain(body);
  expect(body).toContain(POWERSHELL_COMMON);
  expect(body).toContain(SETUP_POWERSHELL_CODEX);
  expect(body).not.toContain(SETUP_POWERSHELL_CLAUDE);
});

test('HEAD validates but returns an empty body', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request(lease.scripts.claude.sh, { method: 'HEAD' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(await response.text(), '');
});

test('near-miss public URLs are consumed before host middleware can log their token', async () => {
  const token = 'a'.repeat(43);
  const downstream = vi.fn();
  const app = new Hono()
    .route('/api/setup', createAgentSetupPublicRoutes({
      repository: { findByToken: () => Promise.resolve(null) },
      userExists: () => Promise.resolve(false),
      resolveApiKey: () => Promise.resolve(null),
    }))
    .use('*', async (c, next) => {
      downstream(c.req.path);
      await next();
    });

  for (const [path, method] of [
    [`/api/setup/${token}/setup.txt`, 'GET'],
    [`/api/setup/${token}/claude.sh/extra`, 'GET'],
    [`/api/setup/${token}/codex.sh`, 'POST'],
    [`/api/setup/${token}`, 'GET'],
    [`/api/setup/${token}x`, 'GET'],
  ] as const) {
    const response = await app.request(path, { method });
    assertEquals(response.status, 404);
    assertEquals(response.headers.get('cache-control'), 'no-store');
  }
  expect(downstream).not.toHaveBeenCalled();

  const control = await app.request('/api/setup/heartbeat', { method: 'POST' });
  assertEquals(control.status, 404);
  expect(downstream).toHaveBeenCalledOnce();
  expect(downstream).toHaveBeenCalledWith('/api/setup/heartbeat');
});

test('GET re-reads the current configuration each request', async () => {
  const h = harness();
  const lease = await create(h);
  expect(await (await h.request(lease.scripts.codex.sh, { method: 'GET' })).text()).toContain("SETUP_CODEX_MODEL=''");
  const edited = { ...lease.configuration, codex: { ...lease.configuration.codex, model: 'gpt-custom' } };
  await h.request('/api/setup', putJson({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }));
  const after = await (await h.request(lease.scripts.codex.sh, { method: 'GET' })).text();
  expect(after).toContain("SETUP_CODEX_MODEL='gpt-custom'");
});

test('unknown, expired, deleted-user, and deleted-key tokens all return an identical generic 404', async () => {
  const h = harness();
  const now = Date.now();
  const config = '{"apiKeyId":"key_primary","claudeCode":{"model":null,"defaultOpusModel":null,"defaultSonnetModel":null,"defaultHaikuModel":null,"effortLevel":null,"cleanupPeriodDays":null,"optOutAiAttribution":false,"modelDiscovery":true},"codex":{"model":null,"reasoningEffort":null}}';

  await h.repo.insertForUser({ userId: USER_ID, token: 'b'.repeat(43), configurationJson: config, now, expiresAt: now - 1 });
  await h.repo.insertForUser({ userId: 99, token: 'c'.repeat(43), configurationJson: config, now, expiresAt: now + 300_000 });
  await h.repo.insertForUser({ userId: USER_ID, token: 'd'.repeat(43), configurationJson: '{"apiKeyId":"key_gone","claudeCode":{"model":null,"defaultOpusModel":null,"defaultSonnetModel":null,"defaultHaikuModel":null,"effortLevel":null,"cleanupPeriodDays":null,"optOutAiAttribution":false,"modelDiscovery":true},"codex":{"model":null,"reasoningEffort":null}}', now, expiresAt: now + 300_000 });

  const bodies = new Set<string>();
  for (const token of ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43), 'd'.repeat(43)]) {
    const response = await h.request(`/api/setup/${token}/claude.sh`, { method: 'GET' });
    assertEquals(response.status, 404);
    bodies.add(await response.text());
  }
  assertEquals(bodies.size, 1);
});

test('a public serve failure is sealed to an opaque 500 that leaks neither token nor secret', async () => {
  const injectedSecret = 'INJECTED-SECRET-sk-abcdef0123456789';
  const lease = { token: 'a'.repeat(43) };
  const h = harness({
    publicOverrides: {
      repository: { findByToken: () => { throw new Error(`forced failure\nsecond line leaking ${lease.token} and ${injectedSecret}`); } },
    },
  });
  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await h.request(`/api/setup/${lease.token}/claude.sh`, { method: 'GET' });
    assertEquals(response.status, 500);
    assertEquals(response.headers.get('cache-control'), 'no-store');
    assertEquals(response.headers.get('pragma'), 'no-cache');
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
    expect(raw).not.toContain(injectedSecret);
  } finally {
    errorSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).toContain('routes_test');
  expect(joined).not.toContain(injectedSecret);
  expect(joined).not.toContain(lease.token);
  expect(joined).not.toContain('forced failure');
});

test('generated fragments match the checked-in canonical installers byte for byte', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixtures = [
    [SETUP_BASH_COMMON_OUTPUT, '../installers/bash/common/output.sh'],
    [SETUP_BASH_COMMON_HELPERS, '../installers/bash/common/helpers.sh'],
    [SETUP_BASH_COMMON_MAIN, '../installers/bash/common/main.sh'],
    [SETUP_BASH_CLAUDE, '../installers/bash/claude.sh'],
    [SETUP_BASH_CODEX, '../installers/bash/codex.sh'],
    [SETUP_POWERSHELL_COMMON_OUTPUT, '../installers/powershell/common/output.ps1'],
    [SETUP_POWERSHELL_COMMON_HELPERS, '../installers/powershell/common/helpers.ps1'],
    [SETUP_POWERSHELL_COMMON_MAIN, '../installers/powershell/common/main.ps1'],
    [SETUP_POWERSHELL_CLAUDE, '../installers/powershell/claude.ps1'],
    [SETUP_POWERSHELL_CODEX, '../installers/powershell/codex.ps1'],
  ] as const;
  for (const [generated, file] of fixtures) {
    assertEquals(generated, await readFile(new URL(file, import.meta.url), 'utf8'));
  }
});
