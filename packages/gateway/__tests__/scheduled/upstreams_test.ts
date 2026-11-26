import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { runUpstreamScheduledTasks } from '../../src/scheduled/upstreams.ts';
import { createSqliteTestDb } from '../repo/test-sqlite.ts';
import { type Fetcher, type UpstreamRecord } from '@floway-dev/provider';

const mocks = vi.hoisted(() => ({ fetch: vi.fn<Fetcher>() }));
vi.mock('../../src/dial/per-request.ts', () => ({ createPerRequestFetcher: async () => () => mocks.fetch }));

const usageBody = (amount = 3.5) => ({ range: '7d', scope: 'self', from: '2026-10-04T00:00:00Z', until: '2026-10-11T12:00:00Z', totals: { request_count: 15, usage_usd: amount } });
const balanceBody = (amount = 3.5) => ({ included: { balance_usd: 60 - amount, allowance_usd: 60, period: { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' } }, purchased: { balance_usd: 25 } });
const NOW = Date.parse('2026-10-11T12:00:00Z');
const access = { token: 'access', expiresAt: NOW + 86_400_000, refreshedAt: new Date(NOW).toISOString() };
const base = (id: string, kind: UpstreamRecord['kind'], config: unknown, state: unknown): UpstreamRecord => ({
  id, kind, config, state, name: id, enabled: true, usageRefreshIntervalMinutes: 5,
  sortOrder: 0, createdAt: '', updatedAt: '', flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [{ id: 'direct_fetch' }], modelPrefix: null, hue: 210,
});
const copilot = (id = 'copilot') => base(id, 'copilot', {
  githubHost: 'github.com', githubToken: 'github', user: { login: 'tester', avatar_url: '', name: null, id: 1 },
}, null);
const chatgpt = () => base('chatgpt', 'chatgpt', {
  accounts: [{ email: 'test@example.com', chatgptAccountId: 'account', chatgptUserId: null, planType: 'plus' }],
}, { accounts: [{ chatgptAccountId: 'account', refresh_token: null, state: 'active', state_updated_at: new Date(NOW).toISOString(), openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: access, quotaSnapshot: null }] });
const claude = (setupToken = false) => base('claude', 'claude-code', {
  accounts: [{ email: 'test@example.com', accountUuid: 'account', organizationUuid: null, subscriptionType: 'max', rateLimitTier: null }],
}, { accounts: [{ accountUuid: 'account', tokenKind: setupToken ? 'setup-token' : 'oauth', refreshToken: setupToken ? null : 'refresh', state: 'active', stateUpdatedAt: new Date(NOW).toISOString(), accessToken: access, quotaSnapshot: null, usageProbeSnapshot: null }] });
const ollama = () => base('ollama', 'ollama', { baseUrl: 'https://ollama.com', apiKey: 'key', cloudUsage: true }, null);

let repo: SqlRepo;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.fetch.mockReset();
  repo = new SqlRepo(await createSqliteTestDb());
  initRepo(repo);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('Floway dispatches every provider and persists read-only subscription probes', async () => {
  for (const record of [copilot(), chatgpt(), claude(), ollama(), base('custom', 'custom', { baseUrl: 'https://custom.example', apiKey: '', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false, authStyle: 'bearer' } }, null), base('azure', 'azure', { endpoint: 'https://test.openai.azure.com', apiKey: 'key' }, null)]) {
    await repo.upstreams.insert({ upstream: record });
  }
  mocks.fetch.mockImplementation(async (url, init) => {
    expect(init.method ?? 'GET').toBe('GET');
    const path = new URL(url).pathname;
    if (path === '/copilot_internal/user') return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 300, quota_remaining: 200, percent_remaining: 200 / 3, unlimited: false } } });
    if (path === '/backend-api/wham/usage') {
      expect(new Headers(init.headers).get('chatgpt-account-id')).toBe('account');
      return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 60 } }, additional_rate_limits: [{ metered_feature: 'images', rate_limit: { secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 600 } } }] });
    }
    if (path === '/api/oauth/usage') return Response.json({ five_hour: { utilization: 10, resets_at: new Date(NOW + 60_000).toISOString() } });
    if (path === '/api/usage') return Response.json(usageBody());
    if (path === '/api/balance') return Response.json(balanceBody());
    throw new Error(`Unexpected scheduled request ${url}`);
  });
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(5);
  expect((await repo.upstreams.getById('chatgpt'))?.state).toMatchObject({ accounts: [{ quotaSnapshot: { codex: { data: { primary_used_percent: 25, primary_window_minutes: 300 } }, images: { data: { secondary_used_percent: 50, secondary_window_minutes: 10080 } } } }] });
  expect((await repo.upstreams.getById('copilot'))?.state).toMatchObject({ quotaSnapshot: { fetchedAt: NOW } });
  expect((await repo.upstreams.getById('claude'))?.state).toMatchObject({ accounts: [{ usageProbeSnapshot: { fetchedAt: NOW, data: { five_hour: { utilization: 10 } } } }] });
  expect((await repo.upstreams.getById('ollama'))?.state).toMatchObject({ usageProbe: { observation: { fetchedAt: NOW, data: { usage: usageBody(), balance: balanceBody() } } } });
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(5);
  vi.setSystemTime(NOW + 300_000);
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(10);
});

test('opt-out, disabled upstreams, setup tokens, local Ollama and scoped-only egress issue no probes', async () => {
  for (const record of [{ ...copilot('opt-out'), usageRefreshIntervalMinutes: 0 }, { ...copilot('disabled'), enabled: false }, claude(true), { ...ollama(), config: { baseUrl: 'https://local.example', cloudUsage: false } }, { ...copilot('scoped'), proxyFallbackList: [{ id: 'direct_fetch', colos: ['TEST'] }] }]) {
    await repo.upstreams.insert({ upstream: record });
  }
  await runUpstreamScheduledTasks(null);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

test('a usage endpoint auth failure preserves inference credential health and other upstreams still run', async () => {
  await repo.upstreams.insert({ upstream: chatgpt() });
  await repo.upstreams.insert({ upstream: ollama() });
  mocks.fetch.mockImplementation(async url => new URL(url).hostname === 'chatgpt.com'
    ? new Response('usage scope denied', { status: 403 })
    : Response.json(new URL(url).pathname === '/api/usage' ? usageBody() : balanceBody()));
  await expect(runUpstreamScheduledTasks('TEST')).rejects.toThrow();
  expect((await repo.upstreams.getById('chatgpt'))?.state).toMatchObject({ accounts: [{ state: 'active' }] });
  expect((await repo.upstreams.getById('ollama'))?.state).toMatchObject({ usageProbe: { observation: { fetchedAt: NOW } } });
});

test('configured minutes control polling using existing usage observations', async () => {
  const record = { ...copilot(), usageRefreshIntervalMinutes: 15 };
  await repo.upstreams.insert({ upstream: record });
  mocks.fetch.mockImplementation(async () => Response.json({ quota_snapshots: { premium_interactions: { entitlement: 300, quota_remaining: 200, percent_remaining: 200 / 3, unlimited: false } } }));
  await runUpstreamScheduledTasks('TEST');
  vi.setSystemTime(NOW + 60_000);
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const updateInterval = async (minutes: number) => {
    const stored = (await repo.upstreams.getById(record.id))!;
    expect(await repo.upstreams.replace({ previous: stored, upstream: { ...stored, usageRefreshIntervalMinutes: minutes }, bumpConfigVersion: false })).not.toBeNull();
  };
  await updateInterval(1);
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  await updateInterval(15);
  vi.setSystemTime(NOW + 15 * 60_000);
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(NOW + 16 * 60_000);
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
  await updateInterval(0);
  vi.setSystemTime(NOW + 24 * 60 * 60_000);
  await runUpstreamScheduledTasks('TEST');
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});
