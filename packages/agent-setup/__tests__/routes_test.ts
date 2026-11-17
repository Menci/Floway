// Domain tests for the Agent Setup route factories, driven against an in-memory
// fake repository and injected dependency callbacks — no HTTP auth, CORS, or
// logger. Those host concerns are exercised where they live (the gateway
// integration test); here we prove the multi-lease lifecycle, the optimistic-
// concurrency discriminants, and the sealed public serve path.

import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

import type { AgentSetupConfiguration } from '../src/configuration.ts';
import { type AgentSetupMutation, type AgentSetupRecord, type AgentSetupRenewal, type AgentSetupRepository, AgentSetupTokenCollisionError } from '../src/repository.ts';
import {
  type AgentSetupControlDeps,
  type AgentSetupPublicDeps,
  createAgentSetupControlRoutes,
  createAgentSetupPublicRoutes,
} from '../src/routes.ts';
import { SETUP_BASH_CLAUDE, SETUP_BASH_COMMON, SETUP_NODE_OMP_EXTENSION, SETUP_NODE_PI_EXTENSION } from '../src/script-assets.generated.ts';
import { SETUP_SCRIPT_BODIES } from '../src/script-assets.ts';
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
  configuration: AgentSetupConfiguration;
  configurationRevision: number;
  expiresAt: number;
  scripts: {
    claude: { sh: string; ps1: string };
    codex: { sh: string; ps1: string };
    pi: { sh: string; ps1: string };
    omp: { sh: string; ps1: string };
  };
}

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

test('POST first use selects the requested key at revision 1', async () => {
  const h = harness();
  const body = await create(h);

  assertEquals(body.status, 'ok');
  assertEquals(body.configuration.apiKeyId, 'key_primary');
  assertEquals(body.configuration.claudeCode.modelDiscovery, true);
  assertEquals(body.configurationRevision, 1);
  expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  assertEquals(body.scripts.claude.sh, `/api/setup/${body.token}/claude.sh`);
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
  expect(text).toContain(body);
  expect(body).toContain(SETUP_BASH_COMMON);
  expect(body).toContain(SETUP_BASH_CLAUDE);
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

test('the leased Pi extension is fixed across configurations and endpoint queries', async () => {
  const h = harness();
  const lease = await (await h.request('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }) })).json() as LeaseResponse;
  const url = `/api/setup/${lease.token}/pi.js?endpoint=${encodeURIComponent('https://gateway.example/prefix')}`;
  const response = await h.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const source = await response.text();
  expect(source).toBe(SETUP_NODE_PI_EXTENSION);
  expect(source).not.toContain('raw-key');

  const head = await h.request(url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  for (const endpoint of ['', 'file:///tmp/file', 'https://user:secret@example.com', 'https://example.com?query=1']) {
    const invalid = await h.request(`/api/setup/${lease.token}/pi.js?endpoint=${encodeURIComponent(endpoint)}`);
    expect(invalid.status).toBe(200);
    expect(await invalid.clone().text()).toBe(source);
    expect(await invalid.text()).not.toContain(RAW_KEY);
  }
  const missing = await h.request(`/api/setup/${'x'.repeat(43)}/pi.js?endpoint=https://example.com`);
  expect(missing.status).toBe(404);
});

test('serves live OMP scripts and a leased extension without affecting Pi preferences', async () => {
  const h = harness();
  const lease = await create(h);
  const configuration = { ...lease.configuration, omp: { model: 'custom-omp-model', provider: 'personal', retry: { enabled: null, maxRetries: null } } };
  await h.request('/api/setup', putJson({ token: lease.token, configuration, expectedRevision: lease.configurationRevision }));
  const sh = await (await h.request(lease.scripts.omp.sh)).text();
  expect(sh).toContain("SETUP_OMP_MODEL='custom-omp-model'");
  expect(sh).toContain("SETUP_OMP_PROVIDER='personal'");
  expect(sh).toContain(`SETUP_EXTENSION_PATH='/api/setup/${lease.token}/omp.js'`);
  const ps = await (await h.request(lease.scripts.omp.ps1)).text();
  expect(ps).toContain("$SetupOmpModel = 'custom-omp-model'");
  const url = `/api/setup/${lease.token}/omp.js?endpoint=${encodeURIComponent('https://gateway.example/prefix')}`;
  const response = await h.request(url);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const source = await response.text();
  expect(source).not.toContain(RAW_KEY);
  expect(source).toBe(SETUP_NODE_OMP_EXTENSION);
  expect(await (await h.request(url, { method: 'HEAD' })).text()).toBe('');
  expect((await h.request(`/api/setup/${lease.token}/omp.js?endpoint=file:///tmp/config`)).status).toBe(200);
  expect(await (await h.request(lease.scripts.pi.sh)).text()).toContain("SETUP_PI_MODEL=''");
});
