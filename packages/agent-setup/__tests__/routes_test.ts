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
      expiresAt: Math.max(row.expiresAt, input.expiresAt),
      updatedAt: input.now,
    };
    this.rows.set(updated.token, updated);
    return Promise.resolve({ status: 'ok', record: { ...updated } });
  }

  renewLease(input: { userId: number; token: string; expiresAt: number }): Promise<AgentSetupRenewal> {
    const row = this.rows.get(input.token);
    if (!row || row.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    const updated: AgentSetupRecord = { ...row, expiresAt: Math.max(row.expiresAt, input.expiresAt) };
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

test('POST first use creates defaults for the requested key at revision 1', async () => {
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

test('malformed JSON bodies stop before any control dependency is called', async () => {
  const listSelectableApiKeyIds = vi.fn(() => Promise.resolve(['key_primary']));
  const h = harness({ controlOverrides: { listSelectableApiKeyIds } });
  const latestSpy = vi.spyOn(h.repo, 'latestByUserId');
  const insertSpy = vi.spyOn(h.repo, 'insertForUser');

  for (const body of ['{', '{}']) {
    const response = await h.request('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toEqual(400);
  }
  expect(listSelectableApiKeyIds).not.toHaveBeenCalled();
  expect(latestSpy).not.toHaveBeenCalled();
  expect(insertSpy).not.toHaveBeenCalled();
});

test('POST restores the latest saved preferences while switching to another selectable key', async () => {
  const h = harness({
    keys: ['key_primary', 'key_other'],
    secrets: { key_primary: RAW_KEY, key_other: 'raw-other' },
  });
  const first = await create(h);
  const edited = { ...first.configuration, codex: { ...first.configuration.codex, reasoningEffort: 'high' } };
  await h.request('/api/setup', putJson({ token: first.token, configuration: edited, expectedRevision: first.configurationRevision }));

  const reopened = await create(h, 'key_other');
  expect(reopened.configuration.apiKeyId).toEqual('key_other');
  expect(reopened.configuration.codex.reasoningEffort).toEqual('high');
  // A reopen inserts a brand-new independent lease; it never reuses a token.
  expect(reopened.token).not.toBe(first.token);
  expect(reopened.configurationRevision).toEqual(1);
});

test('POST restores an expired latest configuration before sweeping its old lease', async () => {
  const h = harness();
  const now = Date.now();
  const token = 'w'.repeat(43);
  const configuration = {
    ...JSON.parse(FULL_CONFIG_JSON('key_primary')) as LeaseResponse['configuration'],
    codex: { model: 'gpt-custom', reasoningEffort: 'high' },
  };
  await h.repo.insertForUser({
    userId: USER_ID,
    token,
    configurationJson: JSON.stringify(configuration),
    now: now - 10_000,
    expiresAt: now - 1,
  });

  const reopened = await create(h);
  expect(reopened.configuration.codex.model).toEqual('gpt-custom');
  expect(reopened.configuration.codex.reasoningEffort).toEqual('high');
  expect(await h.repo.findByToken(token)).toEqual(null);
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

test('create and heartbeat apply the exact five-minute TTL without bumping revision or updated_at', async () => {
  vi.useFakeTimers();
  try {
    const createdAt = Date.parse('2026-08-06T00:00:00.000Z');
    vi.setSystemTime(createdAt);
    const h = harness();
    const lease = await create(h);
    expect(lease.expiresAt).toEqual(createdAt + 300_000);
    const before = await h.repo.findByToken(lease.token);

    const heartbeatAt = createdAt + 12_345;
    vi.setSystemTime(heartbeatAt);
    const response = await h.request('/api/setup/heartbeat', heartbeatJson({ token: lease.token }));
    expect(response.status).toEqual(200);
    const body = (await response.json()) as LeaseResponse;
    expect(body.status).toEqual('ok');
    expect(body.expiresAt).toEqual(heartbeatAt + 300_000);
    expect(body.configurationRevision).toEqual(lease.configurationRevision);
    const after = await h.repo.findByToken(lease.token);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  } finally {
    vi.useRealTimers();
  }
});

test('out-of-order heartbeat completion cannot shorten a newer lease', async () => {
  vi.useFakeTimers();
  const firstEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  try {
    const createdAt = Date.parse('2026-08-06T00:00:00.000Z');
    vi.setSystemTime(createdAt);
    const h = harness();
    const lease = await create(h);
    const renewLease = h.repo.renewLease.bind(h.repo);
    let callCount = 0;
    h.repo.renewLease = async input => {
      callCount += 1;
      if (callCount === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return await renewLease(input);
    };

    const staleHeartbeatAt = createdAt + 10_000;
    vi.setSystemTime(staleHeartbeatAt);
    const staleResponsePromise = h.request('/api/setup/heartbeat', heartbeatJson({ token: lease.token }));
    await firstEntered.promise;

    const newerHeartbeatAt = createdAt + 20_000;
    vi.setSystemTime(newerHeartbeatAt);
    const newerResponse = await h.request('/api/setup/heartbeat', heartbeatJson({ token: lease.token }));
    releaseFirst.resolve();
    const staleResponse = await staleResponsePromise;

    expect(newerResponse.status).toEqual(200);
    expect(staleResponse.status).toEqual(200);
    const expectedExpiry = newerHeartbeatAt + 300_000;
    expect(((await newerResponse.json()) as LeaseResponse).expiresAt).toEqual(expectedExpiry);
    expect(((await staleResponse.json()) as LeaseResponse).expiresAt).toEqual(expectedExpiry);
    expect((await h.repo.findByToken(lease.token))?.expiresAt).toEqual(expectedExpiry);
  } finally {
    releaseFirst.resolve();
    vi.useRealTimers();
  }
});

test('a delayed configuration update cannot shorten a lease extended by a newer heartbeat', async () => {
  vi.useFakeTimers();
  const updateEntered = Promise.withResolvers<void>();
  const releaseUpdate = Promise.withResolvers<void>();
  try {
    const createdAt = Date.parse('2026-08-06T00:00:00.000Z');
    vi.setSystemTime(createdAt);
    const h = harness();
    const lease = await create(h);
    const updateConfiguration = h.repo.updateConfiguration.bind(h.repo);
    h.repo.updateConfiguration = async input => {
      updateEntered.resolve();
      await releaseUpdate.promise;
      return await updateConfiguration(input);
    };

    const staleUpdateAt = createdAt + 10_000;
    vi.setSystemTime(staleUpdateAt);
    const edited = { ...lease.configuration, codex: { ...lease.configuration.codex, model: 'gpt-after-race' } };
    const updateResponsePromise = h.request('/api/setup', putJson({
      token: lease.token,
      configuration: edited,
      expectedRevision: lease.configurationRevision,
    }));
    await updateEntered.promise;

    const newerHeartbeatAt = createdAt + 20_000;
    vi.setSystemTime(newerHeartbeatAt);
    const heartbeatResponse = await h.request('/api/setup/heartbeat', heartbeatJson({ token: lease.token }));
    releaseUpdate.resolve();
    const updateResponse = await updateResponsePromise;

    expect(heartbeatResponse.status).toEqual(200);
    expect(updateResponse.status).toEqual(200);
    const expectedExpiry = newerHeartbeatAt + 300_000;
    const updated = (await updateResponse.json()) as LeaseResponse;
    expect(updated.expiresAt).toEqual(expectedExpiry);
    expect(updated.configurationRevision).toEqual(lease.configurationRevision + 1);
    expect(updated.configuration.codex.model).toEqual('gpt-after-race');
    const stored = await h.repo.findByToken(lease.token);
    expect(stored?.expiresAt).toEqual(expectedExpiry);
    expect(stored?.updatedAt).toEqual(staleUpdateAt);
  } finally {
    releaseUpdate.resolve();
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
  const attemptedTokens: string[] = [];
  h.repo.insertForUser = async input => {
    attemptedTokens.push(input.token);
    if (attemptedTokens.length === 1) throw new AgentSetupTokenCollisionError();
    return await original(input);
  };
  const first = await create(h);
  expect(first.status).toEqual('ok');
  expect(attemptedTokens).toHaveLength(2);
  expect(attemptedTokens[1]).not.toBe(attemptedTokens[0]);
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

test('HEAD validates the lease without invoking the API-key-bearing renderer', async () => {
  const h = harness({ secrets: { key_primary: 'raw\0key' } });
  const lease = await create(h);
  const response = await h.request(lease.scripts.claude.sh, { method: 'HEAD' });
  expect(response.status).toEqual(200);
  expect(response.headers.get('cache-control')).toEqual('no-store');
  expect(await response.text()).toEqual('');

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const get = await h.request(lease.scripts.claude.sh, { method: 'GET' });
    expect(get.status).toEqual(500);
  } finally {
    errorSpy.mockRestore();
  }
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

test('a lease expiring at the current millisecond is no longer servable', async () => {
  vi.useFakeTimers();
  try {
    const now = Date.parse('2026-08-06T00:00:00.000Z');
    vi.setSystemTime(now);
    const h = harness();
    const token = 'e'.repeat(43);
    await h.repo.insertForUser({
      userId: USER_ID,
      token,
      configurationJson: FULL_CONFIG_JSON('key_primary'),
      now: now - 10_000,
      expiresAt: now,
    });
    const response = await h.request(`/api/setup/${token}/claude.sh`, { method: 'GET' });
    expect(response.status).toEqual(404);
  } finally {
    vi.useRealTimers();
  }
});

const hostilePublicErrors = [
  {
    label: 'an at-prefixed multiline message',
    create: (token: string, secret: string) => new Error(`safe first line\n    at ${secret}-${token}`),
  },
  {
    label: 'an attacker-controlled name',
    create: (token: string, secret: string) => {
      const error = new Error('safe message');
      error.name = `${secret}-${token}`;
      return error;
    },
  },
  {
    label: 'a forged stack frame',
    create: (token: string, secret: string) => {
      const error = new Error('safe message');
      error.stack = `Error: safe message\n    at ${secret}-${token} (routes.ts:1:1)`;
      return error;
    },
  },
  {
    label: 'a throwing stack getter',
    create: (_token: string, secret: string) => {
      const error = new Error('safe message');
      Object.defineProperty(error, 'stack', { get: () => { throw new Error(secret); } });
      return error;
    },
  },
  {
    label: 'a throwing name getter',
    create: (_token: string, secret: string) => {
      const error = new Error('safe message');
      Object.defineProperty(error, 'name', { get: () => { throw new Error(secret); } });
      return error;
    },
  },
  {
    label: 'a non-string stack',
    create: () => {
      const error = new Error('safe message');
      Object.defineProperty(error, 'stack', { value: 42 });
      return error;
    },
  },
  {
    label: 'a hostile error proxy',
    create: (token: string, secret: string) => new Proxy(new Error('safe message'), {
      getPrototypeOf: () => { throw new Error(`${secret}-${token}`); },
    }),
  },
] as const;

test.each(hostilePublicErrors)('a public serve failure from $label stays totally opaque', async ({ create: createError }) => {
  const injectedSecret = 'INJECTED-SECRET-sk-abcdef0123456789';
  const token = 'a'.repeat(43);
  const h = harness({
    publicOverrides: {
      repository: { findByToken: () => { throw createError(token, injectedSecret); } },
    },
  });
  const logged: unknown[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(...args); });
  try {
    const response = await h.request(`/api/setup/${token}/claude.sh`, { method: 'GET' });
    expect(response.status).toEqual(500);
    expect(response.headers.get('cache-control')).toEqual('no-store');
    expect(response.headers.get('pragma')).toEqual('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
    expect(raw).not.toContain(injectedSecret);
    expect(raw).not.toContain(token);
  } finally {
    errorSpy.mockRestore();
  }
  expect(logged).toHaveLength(1);
  const diagnostic = logged[0];
  expect(diagnostic).toBeInstanceOf(Error);
  if (!(diagnostic instanceof Error)) throw new Error('public diagnostic was not an Error');
  expect(diagnostic.message).toBe('Agent Setup: failed to serve a public setup script');
  expect(diagnostic.stack).toContain('reportPublicServeFailure');
  const diagnosticText = `${diagnostic.name}\n${diagnostic.message}\n${diagnostic.stack}`;
  expect(diagnosticText).not.toContain(injectedSecret);
  expect(diagnosticText).not.toContain(token);
});

test('a public response remains opaque when the host logger throws', async () => {
  const token = 'a'.repeat(43);
  const h = harness({
    publicOverrides: { repository: { findByToken: () => { throw new Error('repository secret'); } } },
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('logger secret'); });
  try {
    const response = await h.request(`/api/setup/${token}/claude.sh`, { method: 'GET' });
    expect(response.status).toEqual(500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: { type: 'internal_error' } });
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('secret');
  } finally {
    errorSpy.mockRestore();
  }
});
