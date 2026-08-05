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
import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
} from '../src/script-assets.generated.ts';
import { SETUP_SCRIPT_BODIES } from '../src/script-assets.ts';

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
  };
}

// A full, schema-valid configuration for rows seeded directly into the repo
// (leaseProjection and restore both parse the stored JSON through the schema).
const fullConfiguration = (apiKeyId: string): AgentSetupConfiguration => ({
  apiKeyId,
  claudeCode: { model: null, defaultFableModel: null, defaultOpusModel: null, defaultSonnetModel: null, defaultHaikuModel: null, effortLevel: null, cleanupPeriodDays: null, optOutAiAttribution: false, modelDiscovery: true },
  codex: { model: null, reasoningEffort: null },
});
const FULL_CONFIG_JSON = (apiKeyId: string): string => JSON.stringify(fullConfiguration(apiKeyId));

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
  expect(response.status).toBe(200);
  return (await response.json()) as LeaseResponse;
};

// --- create: first use, restore, multi-page independence ---

test('POST first use selects the first key and enables both agents at revision 1', async () => {
  const h = harness();
  const body = await create(h);

  expect(body.status).toEqual('ok');
  expect(body.configuration.apiKeyId).toEqual('key_primary');
  expect(body.configuration.claudeCode.modelDiscovery).toEqual(true);
  expect(body.configuration.claudeCode.model).toEqual(null);
  expect(body.configuration.claudeCode.cleanupPeriodDays).toEqual(null);
  expect(body.configuration.claudeCode.optOutAiAttribution).toEqual(false);
  expect(body.configurationRevision).toEqual(1);
  expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(body.scripts.claude.sh).toEqual(`/api/setup/${body.token}/claude.sh`);
  expect(body.scripts.claude.ps1).toEqual(`/api/setup/${body.token}/claude.ps1`);
  expect(body.scripts.codex.sh).toEqual(`/api/setup/${body.token}/codex.sh`);
  expect(body.scripts.codex.ps1).toEqual(`/api/setup/${body.token}/codex.ps1`);
});

test('POST creates the lease for the requested selectable key', async () => {
  const h = harness({ keys: ['key_primary', 'key_other'], secrets: { key_primary: RAW_KEY, key_other: 'raw-other' } });
  const body = await create(h, 'key_other');
  expect(body.configuration.apiKeyId).toEqual('key_other');
  expect(JSON.parse((await h.repo.findByToken(body.token))!.configurationJson).apiKeyId).toEqual('key_other');
});

test('POST projects scripts from the host-supplied public route path', async () => {
  const h = harness({ routePath: '/custom/agent-setup' });
  const response = await h.request('/custom/agent-setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
  });
  expect(response.status).toEqual(200);
  const body = (await response.json()) as LeaseResponse;
  expect(body.scripts.claude.sh).toEqual(`/custom/agent-setup/${body.token}/claude.sh`);
  expect(body.scripts.codex.ps1).toEqual(`/custom/agent-setup/${body.token}/codex.ps1`);
});

test('POST returns no-selectable-key when the account has no key', async () => {
  const h = harness({ keys: [] });
  const response = await h.request('/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
  });
  expect(response.status).toEqual(409);
  expect(((await response.json()) as { status: string }).status).toEqual('no-selectable-key');
});

test('POST rejects a requested key outside a non-empty selectable set before reading saved state', async () => {
  const h = harness({ keys: ['key_primary'] });
  const latestByUserId = vi.spyOn(h.repo, 'latestByUserId');
  const response = await h.request('/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_foreign' }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'The selected API key is not available on your account.' });
  expect(latestByUserId).not.toHaveBeenCalled();
  expect(h.repo.rows.size).toBe(0);
});

test('POST restores the latest saved configuration whose key is still selectable', async () => {
  const h = harness();
  const first = await create(h);
  const edited = { ...first.configuration, codex: { ...first.configuration.codex, reasoningEffort: 'high' } };
  await h.request('/api/setup', putJson({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }));

  const reopened = await create(h);
  expect(reopened.configuration.codex.reasoningEffort).toEqual('high');
  // A reopen inserts a brand-new independent lease; it never reuses a token.
  expect(reopened.token).not.toBe(first.token);
  expect(reopened.configurationRevision).toEqual(1);
});

test('POST falls back to a first-use default when the latest config points at an unselectable key', async () => {
  const h = harness({ keys: ['key_other'], secrets: { key_other: 'raw-other' } });
  const saved = { ...fullConfiguration('key_primary'), codex: { model: null, reasoningEffort: 'high' } };
  const now = Date.now();
  await h.repo.insertForUser({ userId: USER_ID, token: 'x'.repeat(43), configurationJson: JSON.stringify(saved), now, expiresAt: now + 300_000 });

  const reopened = await create(h, 'key_other');
  expect(reopened.configuration.apiKeyId).toEqual('key_other');
  expect(reopened.configuration.codex.reasoningEffort).toEqual(null);
});

test('two POSTs coexist as independent leases: neither supersedes the other', async () => {
  const h = harness();
  const a = await create(h);
  const b = await create(h);
  expect(b.token).not.toBe(a.token);
  // Both tokens remain live and independently servable.
  expect((await h.request(`/api/setup/${a.token}/claude.sh`, { method: 'HEAD' })).status).toEqual(200);
  expect((await h.request(`/api/setup/${b.token}/codex.sh`, { method: 'HEAD' })).status).toEqual(200);
});

// --- update + heartbeat discriminants ---

test('PUT updates configuration, bumps the revision, and never rotates the token', async () => {
  const h = harness();
  const lease = await create(h);
  const edited = { ...lease.configuration, claudeCode: { ...lease.configuration.claudeCode, effortLevel: 'high' as const } };
  const response = await h.request('/api/setup', putJson({ token: lease.token, configuration: edited, expectedRevision: lease.configurationRevision }));
  expect(response.status).toEqual(200);
  const body = (await response.json()) as LeaseResponse;
  expect(body.status).toEqual('ok');
  expect(body.configuration.claudeCode.effortLevel).toEqual('high');
  expect(body.configurationRevision).toEqual(lease.configurationRevision + 1);
  expect(body.token).toEqual(lease.token);
});

test('PUT on a token that does not exist is a terminal 409 missing', async () => {
  const h = harness();
  const response = await h.request('/api/setup', putJson({ token: 'z'.repeat(43), configuration: fullConfiguration('key_primary'), expectedRevision: 1 }));
  expect(response.status).toEqual(409);
  expect(((await response.json()) as { status: string }).status).toEqual('missing');
});

test('PUT with a stale revision returns revision-conflict carrying the current lease', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request('/api/setup', putJson({ token: lease.token, configuration: lease.configuration, expectedRevision: lease.configurationRevision + 99 }));
  expect(response.status).toEqual(409);
  const body = (await response.json()) as LeaseResponse;
  expect(body.status).toEqual('revision-conflict');
  expect(body.configurationRevision).toEqual(lease.configurationRevision);
});

test('PUT rejecting an unavailable key returns a 400 that leaks nothing', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request('/api/setup', putJson({
    token: lease.token,
    configuration: { ...lease.configuration, apiKeyId: 'key_foreign' },
    expectedRevision: lease.configurationRevision,
  }));
  expect(response.status).toEqual(400);
  const errorBody = (await response.json()) as Record<string, unknown>;
  expect(errorBody.error).toEqual('The selected API key is not available on your account.');
  expect(errorBody).not.toHaveProperty('token');
  expect(JSON.stringify(errorBody)).not.toContain(lease.token);
});

test('heartbeat renews expiry without bumping revision or updated_at', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000_000);
    const h = harness();
    const lease = await create(h);
    const before = await h.repo.findByToken(lease.token);
    vi.setSystemTime(1_001_234);

    const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: lease.token }));
    expect(response.status).toEqual(200);
    const body = (await response.json()) as LeaseResponse;
    expect(body.status).toEqual('ok');
    expect(body.expiresAt).toEqual(1_301_234);
    expect(body.configurationRevision).toEqual(lease.configurationRevision);
    const after = await h.repo.findByToken(lease.token);
    expect(after!.expiresAt).toEqual(1_301_234);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  } finally {
    vi.useRealTimers();
  }
});

test('heartbeat on a missing token is a terminal 409 missing', async () => {
  const h = harness();
  const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: 'q'.repeat(43) }));
  expect(response.status).toEqual(409);
  expect(((await response.json()) as { status: string }).status).toEqual('missing');
});

test('heartbeat renews an expired-but-still-present lease', async () => {
  const h = harness();
  const now = Date.now();
  await h.repo.insertForUser({ userId: USER_ID, token: 'p'.repeat(43), configurationJson: FULL_CONFIG_JSON('key_primary'), now: now - 10_000, expiresAt: now - 1 });
  const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: 'p'.repeat(43) }));
  expect(response.status).toEqual(200);
  const body = (await response.json()) as LeaseResponse;
  expect(body.expiresAt).toBeGreaterThan(now);
});

test('POST retries a token collision with a fresh token', async () => {
  const h = harness();
  const original = h.repo.insertForUser.bind(h.repo);
  let calls = 0;
  h.repo.insertForUser = async input => {
    calls += 1;
    if (calls === 1) throw new AgentSetupTokenCollisionError();
    return await original(input);
  };
  const first = await create(h);
  expect(first.status).toEqual('ok');
  expect(calls).toBe(2);
});

test('POST stops after five consecutive token collisions', async () => {
  const h = harness();
  let attempts = 0;
  h.repo.insertForUser = () => { attempts += 1; throw new AgentSetupTokenCollisionError(); };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await h.request('/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
    });
    expect(response.status).toBe(500);
    expect(attempts).toBe(5);
  } finally {
    errorSpy.mockRestore();
  }
});

test('POST propagates an unrelated insertion failure without retrying it', async () => {
  const h = harness();
  let attempts = 0;
  h.repo.insertForUser = () => { attempts += 1; throw new Error('disk I/O error'); };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const failed = await h.request('/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKeyId: 'key_primary' }),
    });
    expect(failed.status).toEqual(500);
    expect(attempts).toBe(1);
  } finally {
    errorSpy.mockRestore();
  }
});

test.each([
  ['PUT', (token: string) => putJson({ token, configuration: fullConfiguration('key_primary'), expectedRevision: 1 })],
  ['heartbeat', (token: string) => heartbeatJson({ token })],
] as const)('%s cannot mutate another user\'s lease', async (_operation, init) => {
  const h = harness();
  const token = 'f'.repeat(43);
  const now = Date.now();
  await h.repo.insertForUser({ userId: USER_ID + 1, token, configurationJson: FULL_CONFIG_JSON('key_primary'), now, expiresAt: now + 300_000 });

  const response = await h.request(_operation === 'PUT' ? '/api/setup' : '/api/setup/heartbeat', init(token));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ status: 'missing' });
  expect((await h.repo.findByToken(token))?.configurationRevision).toBe(1);
  expect((await h.repo.findByToken(token))?.expiresAt).toBe(now + 300_000);
});

// --- public serve ---

test('GET serves the shell prefix + common and target-agent fragments with hardened no-store headers', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request(lease.scripts.claude.sh, { method: 'GET' });
  expect(response.status).toEqual(200);
  expect(response.headers.get('content-type')).toEqual('text/plain; charset=utf-8');
  expect(response.headers.get('cache-control')).toEqual('no-store');
  expect(response.headers.get('pragma')).toEqual('no-cache');
  expect(response.headers.get('expires')).toEqual('0');
  expect(response.headers.get('referrer-policy')).toEqual('no-referrer');
  expect(response.headers.get('x-content-type-options')).toEqual('nosniff');
  const text = await response.text();
  const body = SETUP_SCRIPT_BODIES.claude.sh;
  const prefix = text.slice(0, text.indexOf(body));
  expect(prefix).toContain("SETUP_API_KEY='raw-key'");
  expect(prefix).toContain('SETUP_CLAUDE_');
  expect(prefix).not.toContain('SETUP_CODEX_');
  expect(prefix).not.toContain('SETUP_ENDPOINT');
  expect(text).toContain(body);
  expect(body).toContain(SETUP_BASH_COMMON);
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
  expect(body).toContain(SETUP_POWERSHELL_COMMON);
  expect(body).toContain(SETUP_POWERSHELL_CODEX);
  expect(body).not.toContain(SETUP_POWERSHELL_CLAUDE);
});

test('HEAD validates but returns an empty body', async () => {
  const h = harness();
  const lease = await create(h);
  const response = await h.request(lease.scripts.claude.sh, { method: 'HEAD' });
  expect(response.status).toEqual(200);
  expect(response.headers.get('cache-control')).toEqual('no-store');
  expect(await response.text()).toEqual('');
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
    expect(response.status).toEqual(404);
    expect(response.headers.get('cache-control')).toEqual('no-store');
  }
  expect(downstream).not.toHaveBeenCalled();

  const control = await app.request('/api/setup/heartbeat', { method: 'POST' });
  expect(control.status).toEqual(404);
  expect(downstream).toHaveBeenCalledOnce();
  expect(downstream).toHaveBeenCalledWith('/api/setup/heartbeat');
});

test('malformed public tokens never reach lease storage', async () => {
  const findByToken = vi.fn(() => Promise.resolve(null));
  const app = new Hono().route('/api/setup', createAgentSetupPublicRoutes({
    repository: { findByToken },
    userExists: () => Promise.resolve(false),
    resolveApiKey: () => Promise.resolve(null),
  }));

  for (const token of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`]) {
    expect((await app.request(`/api/setup/${token}/claude.sh`)).status).toBe(404);
  }
  expect(findByToken).not.toHaveBeenCalled();
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
  const row = (token: string, overrides: Partial<AgentSetupRecord>): AgentSetupRecord => ({
    token,
    userId: USER_ID,
    configurationJson: FULL_CONFIG_JSON('key_primary'),
    configurationRevision: 1,
    expiresAt: now + 300_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  h.repo.rows.set('b'.repeat(43), row('b'.repeat(43), { expiresAt: now - 1 }));
  h.repo.rows.set('c'.repeat(43), row('c'.repeat(43), { userId: 99 }));
  h.repo.rows.set('d'.repeat(43), row('d'.repeat(43), { configurationJson: FULL_CONFIG_JSON('key_gone') }));

  const bodies = new Set<string>();
  for (const token of ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43), 'd'.repeat(43)]) {
    const response = await h.request(`/api/setup/${token}/claude.sh`, { method: 'GET' });
    expect(response.status).toEqual(404);
    bodies.add(await response.text());
  }
  expect(bodies.size).toEqual(1);
});

test('a public serve failure is sealed to an opaque 500 that leaks neither token nor secret', async () => {
  const injectedSecret = 'INJECTED-SECRET-sk-abcdef0123456789';
  const lease = { token: 'a'.repeat(43) };
  const h = harness({
    publicOverrides: {
      repository: {
        findByToken: () => {
          const error = new Error(`forced failure\nsecond line leaking ${lease.token} and ${injectedSecret}`);
          error.name = injectedSecret;
          throw error;
        },
      },
    },
  });
  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await h.request(`/api/setup/${lease.token}/claude.sh`, { method: 'GET' });
    expect(response.status).toEqual(500);
    expect(response.headers.get('cache-control')).toEqual('no-store');
    expect(response.headers.get('pragma')).toEqual('no-cache');
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

test.each([
  ['a throwing stack getter', (token: string, secret: string) => {
    const error = new Error('hidden');
    Object.defineProperty(error, 'stack', { get: () => { throw new Error(`${token}:${secret}`); } });
    return error;
  }],
  ['a non-string stack', (_token: string, _secret: string) => {
    const error = new Error('hidden');
    Object.defineProperty(error, 'stack', { value: 42 });
    return error;
  }],
  ['a hostile error proxy', (token: string, secret: string) => new Proxy(new Error('hidden'), {
    getPrototypeOf: () => { throw new Error(`${token}:${secret}`); },
  })],
] satisfies readonly [name: string, makeError: (token: string, secret: string) => Error][])('pathological public errors with %s remain sealed', async (_case, makeError) => {
  const token = 'g'.repeat(43);
  const secret = 'INJECTED-PATHOLOGICAL-SECRET';
  const h = harness({ publicOverrides: { repository: { findByToken: () => { throw makeError(token, secret); } } } });
  const logged: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  try {
    const response = await h.request(`/api/setup/${token}/claude.sh`);
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({ error: { type: 'internal_error' } });
  } finally {
    errorSpy.mockRestore();
  }
  expect(logged.join('\n')).not.toContain(token);
  expect(logged.join('\n')).not.toContain(secret);
});
