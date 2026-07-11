// Domain tests for the Agent Setup route factories, driven against an in-memory
// fake repository and injected dependency callbacks — no HTTP auth, CORS, or
// logger. Those host concerns are exercised where they live (the gateway
// integration test); here we prove the multi-lease lifecycle, the optimistic-
// concurrency discriminants, and the sealed public serve path.

import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import { type AgentSetupMutation, type AgentSetupRecord, type AgentSetupRepository, AgentSetupTokenCollisionError } from './repository.ts';
import {
  type AgentSetupControlDeps,
  type AgentSetupPublicDeps,
  createAgentSetupControlRoutes,
  createAgentSetupPublicRoutes,
} from './routes.ts';
import { SETUP_PS1_BODY, SETUP_SH_BODY } from './script-assets.generated.ts';
import { assertEquals } from '@floway-dev/test-utils';

const RAW_KEY = 'raw-key';
const USER_ID = 2;

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
    userId: number; token: string; apiKeyId: string; configurationJson: string; now: number; expiresAt: number;
  }): Promise<AgentSetupRecord> {
    if (this.rows.has(input.token)) throw new AgentSetupTokenCollisionError();
    const record: AgentSetupRecord = {
      token: input.token,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
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
    userId: number; token: string; expectedRevision: number; apiKeyId: string; configurationJson: string; now: number; expiresAt: number;
  }): Promise<AgentSetupMutation> {
    const row = this.rows.get(input.token);
    if (!row || row.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    if (row.configurationRevision !== input.expectedRevision) return Promise.resolve({ status: 'revision-conflict', record: { ...row } });
    const updated: AgentSetupRecord = {
      ...row,
      apiKeyId: input.apiKeyId,
      configurationJson: input.configurationJson,
      configurationRevision: row.configurationRevision + 1,
      expiresAt: input.expiresAt,
      updatedAt: input.now,
    };
    this.rows.set(updated.token, updated);
    return Promise.resolve({ status: 'ok', record: { ...updated } });
  }

  renewLease(input: { userId: number; token: string; expiresAt: number }): Promise<AgentSetupMutation> {
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
  keys?: readonly string[];
  secrets?: Record<string, string>;
  users?: readonly number[];
  publicOverrides?: Partial<AgentSetupPublicDeps>;
  controlOverrides?: Partial<AgentSetupControlDeps<Record<never, never>>>;
} = {}): Harness => {
  const repo = new FakeAgentSetupRepository();
  const keys = options.keys ?? ['key_primary'];
  const secrets = options.secrets ?? { key_primary: RAW_KEY };
  const users = new Set(options.users ?? [USER_ID]);

  const publicDeps: AgentSetupPublicDeps = {
    repository: repo,
    userExists: userId => Promise.resolve(users.has(userId)),
    resolveApiKeySecret: (_userId, apiKeyId) => Promise.resolve(secrets[apiKeyId] ?? null),
    ...options.publicOverrides,
  };
  const controlDeps: AgentSetupControlDeps<Record<never, never>> = {
    repository: repo,
    getUserId: () => USER_ID,
    listSelectableApiKeyIds: () => Promise.resolve(keys),
    ...options.controlOverrides,
  };

  const app = new Hono()
    .route('/api/setup', createAgentSetupPublicRoutes(publicDeps))
    .route('/api/setup', createAgentSetupControlRoutes(controlDeps));

  return { repo, request: (path, init) => app.request(path, init ?? {}) as Promise<Response> };
};

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

// A full, schema-valid configuration for rows seeded directly into the repo
// (leaseProjection and restore both parse the stored JSON through the schema).
const FULL_CONFIG_JSON = (apiKeyId: string): string => JSON.stringify({
  apiKeyId,
  claudeCode: { enabled: true, model: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, modelDiscovery: true },
  codex: { enabled: true, model: null, reasoningEffort: null },
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

const create = async (h: Harness): Promise<LeaseResponse> => {
  const response = await h.request('/api/setup', { method: 'POST' });
  assertEquals(response.status, 200);
  return (await response.json()) as LeaseResponse;
};

// --- create: first use, restore, multi-page independence ---

test('POST first use selects the first key and enables both agents at revision 1', async () => {
  const h = harness();
  const body = await create(h);

  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.apiKeyId, 'key_primary');
  assertEquals(body.configuration.claudeCode.enabled, true);
  assertEquals(body.configuration.codex.enabled, true);
  assertEquals(body.configuration.claudeCode.modelDiscovery, true);
  assertEquals(body.configuration.claudeCode.model, null);
  assertEquals(body.configurationRevision, 1);
  expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  assertEquals(body.scripts.sh, `/api/setup/${body.token}/setup.sh`);
  assertEquals(body.scripts.ps1, `/api/setup/${body.token}/setup.ps1`);
});

test('POST returns no-selectable-key when the account has no key', async () => {
  const h = harness({ keys: [] });
  const response = await h.request('/api/setup', { method: 'POST' });
  assertEquals(response.status, 409);
  assertEquals(((await response.json()) as { status: string }).status, 'no-selectable-key');
});

test('POST restores the latest saved configuration whose key is still selectable', async () => {
  const h = harness();
  const first = await create(h);
  const edited = { ...first.configuration, codex: { ...first.configuration.codex, enabled: false } };
  await h.request('/api/setup', putJson({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }));

  const reopened = await create(h);
  assertEquals(reopened.configuration.codex.enabled, false);
  // A reopen inserts a brand-new independent lease; it never reuses a token.
  expect(reopened.token).not.toBe(first.token);
  assertEquals(reopened.configurationRevision, 1);
});

test('POST falls back to a first-use default when the latest config points at an unselectable key', async () => {
  const h = harness();
  const first = await create(h);
  // Persist a configuration whose key later becomes unselectable.
  const edited = { ...first.configuration, apiKeyId: 'key_primary', codex: { ...first.configuration.codex, enabled: false } };
  await h.request('/api/setup', putJson({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }));

  // Now only a different key is selectable; the saved config cannot be restored.
  const h2 = harness({ keys: ['key_other'], secrets: { key_other: 'raw-other' } });
  // Seed h2's repo with the same saved (unselectable) latest row.
  await h2.repo.insertForUser({ userId: USER_ID, token: 'x'.repeat(43), apiKeyId: 'key_primary', configurationJson: JSON.stringify(edited), now: Date.now(), expiresAt: Date.now() + 300_000 });
  const reopened = await create(h2);
  assertEquals(reopened.configuration.apiKeyId, 'key_other');
  assertEquals(reopened.configuration.codex.enabled, true);
});

test('two POSTs coexist as independent leases: neither supersedes the other', async () => {
  const h = harness();
  const a = await create(h);
  const b = await create(h);
  expect(b.token).not.toBe(a.token);
  // Both tokens remain live and independently servable.
  assertEquals((await h.request(`/api/setup/${a.token}/setup.sh`, { method: 'HEAD' })).status, 200);
  assertEquals((await h.request(`/api/setup/${b.token}/setup.sh`, { method: 'HEAD' })).status, 200);
});

test('inserting a new lease sweeps only the same user\'s already-expired rows', async () => {
  const h = harness();
  const now = Date.now();
  // An expired sibling and a still-live sibling.
  await h.repo.insertForUser({ userId: USER_ID, token: 'e'.repeat(43), apiKeyId: 'key_primary', configurationJson: FULL_CONFIG_JSON('key_primary'), now: now - 10_000, expiresAt: now - 1 });
  const live = await create(h);
  // The expired row is gone; the live rows survive.
  assertEquals(await h.repo.findByToken('e'.repeat(43)), null);
  expect(await h.repo.findByToken(live.token)).not.toBeNull();
});

// --- update + heartbeat discriminants ---

test('PUT updates configuration, bumps the revision, and never rotates the token', async () => {
  const h = harness();
  const lease = await create(h);
  const edited = { ...lease.configuration, claudeCode: { ...lease.configuration.claudeCode, enabled: false } };
  const response = await h.request('/api/setup', putJson({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }));
  assertEquals(response.status, 200);
  const body = (await response.json()) as LeaseResponse;
  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.claudeCode.enabled, false);
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
  await h.repo.insertForUser({ userId: USER_ID, token: 'p'.repeat(43), apiKeyId: 'key_primary', configurationJson: FULL_CONFIG_JSON('key_primary'), now: now - 10_000, expiresAt: now - 1 });
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
    const failed = await h.request('/api/setup', { method: 'POST' });
    assertEquals(failed.status, 500);
    expect(attempts).toBe(1);
  } finally {
    errorSpy.mockRestore();
  }
});

// --- public serve ---

test('GET serves the shell prefix + fixed body with hardened no-store headers', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request(lease.scripts.sh, { method: 'GET' });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assertEquals(response.headers.get('cache-control'), 'no-store');
  assertEquals(response.headers.get('pragma'), 'no-cache');
  assertEquals(response.headers.get('expires'), '0');
  assertEquals(response.headers.get('referrer-policy'), 'no-referrer');
  assertEquals(response.headers.get('x-content-type-options'), 'nosniff');
  const text = await response.text();
  const prefix = text.slice(0, text.indexOf(SETUP_SH_BODY));
  expect(prefix).toContain("FLOWAY_API_KEY='raw-key'");
  expect(prefix).not.toContain('FLOWAY_BASE_URL');
  expect(text).toContain(SETUP_SH_BODY);
});

test('GET serves the PowerShell prefix + fixed body', async () => {
  const h = harness();
  const lease = await create(h);
  const text = await (await h.request(lease.scripts.ps1, { method: 'GET' })).text();
  const prefix = text.slice(0, text.indexOf(SETUP_PS1_BODY));
  expect(prefix).toContain("$FlowayApiKey = 'raw-key'");
  expect(text).toContain(SETUP_PS1_BODY);
});

test('HEAD validates but returns an empty body', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request(lease.scripts.sh, { method: 'HEAD' });
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
      resolveApiKeySecret: () => Promise.resolve(null),
    }))
    .use('*', async (c, next) => {
      downstream(c.req.path);
      await next();
    });

  for (const [path, method] of [
    [`/api/setup/${token}/setup.txt`, 'GET'],
    [`/api/setup/${token}/setup.sh/extra`, 'GET'],
    [`/api/setup/${token}/setup.sh`, 'POST'],
    [`/api/setup/${token}`, 'GET'],
  ] as const) {
    const response = await app.request(path, { method });
    assertEquals(response.status, 404);
    assertEquals(response.headers.get('cache-control'), 'no-store');
  }
  expect(downstream).not.toHaveBeenCalled();
});

test('GET re-reads the current configuration each request', async () => {
  const h = harness();
  const lease = await create(h);
  expect(await (await h.request(lease.scripts.sh, { method: 'GET' })).text()).toContain("FLOWAY_INSTALL_CODEX='1'");
  const edited = { ...lease.configuration, codex: { ...lease.configuration.codex, enabled: false } };
  await h.request('/api/setup', putJson({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }));
  const after = await (await h.request(lease.scripts.sh, { method: 'GET' })).text();
  expect(after).toContain("FLOWAY_INSTALL_CODEX=''");
});

test('unknown, expired, deleted-user, and deleted-key tokens all return an identical generic 404', async () => {
  const h = harness();
  const now = Date.now();
  const config = '{"apiKeyId":"key_primary","claudeCode":{"enabled":true,"model":null,"defaultSonnetModel":null,"defaultHaikuModel":null,"effortLevel":null,"modelDiscovery":true},"codex":{"enabled":true,"model":null,"reasoningEffort":null}}';

  await h.repo.insertForUser({ userId: USER_ID, token: 'b'.repeat(43), apiKeyId: 'key_primary', configurationJson: config, now, expiresAt: now - 1 });
  await h.repo.insertForUser({ userId: 99, token: 'c'.repeat(43), apiKeyId: 'key_primary', configurationJson: config, now, expiresAt: now + 300_000 });
  await h.repo.insertForUser({ userId: USER_ID, token: 'd'.repeat(43), apiKeyId: 'key_gone', configurationJson: '{"apiKeyId":"key_gone","claudeCode":{"enabled":true,"model":null,"defaultSonnetModel":null,"defaultHaikuModel":null,"effortLevel":null,"modelDiscovery":true},"codex":{"enabled":true,"model":null,"reasoningEffort":null}}', now, expiresAt: now + 300_000 });

  const bodies = new Set<string>();
  for (const token of ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43), 'd'.repeat(43)]) {
    const response = await h.request(`/api/setup/${token}/setup.sh`, { method: 'GET' });
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
      repository: { findByToken: () => { throw new Error(`forced failure leaking ${lease.token} and ${injectedSecret}`); } },
    },
  });
  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await h.request(`/api/setup/${lease.token}/setup.sh`, { method: 'GET' });
    assertEquals(response.status, 500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
    expect(raw).not.toContain(injectedSecret);
  } finally {
    errorSpy.mockRestore();
  }
  const joined = logged.join('\n');
  expect(joined).not.toContain(injectedSecret);
  expect(joined).not.toContain('forced failure');
});

test('generated bodies match the checked-in canonical installers byte for byte', async () => {
  const { readFile } = await import('node:fs/promises');
  const sh = await readFile(new URL('../installers/setup.sh', import.meta.url), 'utf8');
  const ps1 = await readFile(new URL('../installers/setup.ps1', import.meta.url), 'utf8');
  assertEquals(SETUP_SH_BODY, sh);
  assertEquals(SETUP_PS1_BODY, ps1);
});
