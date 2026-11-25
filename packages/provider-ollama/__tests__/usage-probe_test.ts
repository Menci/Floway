import { expect, test, vi } from 'vitest';

import { CREDIT_BALANCE as BALANCE_BODY, USAGE_TOTALS as USAGE_BODY } from './usage-fixture.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import {
  isOllamaUsageEnabled,
  refreshOllamaUsageProbe,
} from '../src/usage-probe.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_ollama_usage';

const cloudRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: UPSTREAM_ID,
  kind: 'ollama',
  name: 'Ollama Cloud',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test', cloudUsage: true, models: [] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

// Installs a repo whose single row starts from `state` and records every write.
const withStateRepo = (state: unknown = null) => {
  let current = state;
  const writes: unknown[] = [];
  const metrics: Array<{ name: string; labels: Record<string, string | number | boolean | null>; value: number; timestamp: number }> = [];
  initProviderRepo(() => ({
    recordUpstreamMetric: async (_upstreamId, name, labels, value, timestamp) => { metrics.push({ name, labels: { ...labels }, value, timestamp }); },
    upstreams: {
      getById: async () => ({ ...cloudRecord(), state: current, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        current = mutate(current, 1);
        writes.push(current);
      },
    },
  }));
  return { read: () => readOllamaUpstreamState(current), writes, metrics };
};

test('a failed endpoint preserves both prior readings and records one refresh outcome', async () => {
  const failedPath = '/api/balance';
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();
  await withMockedFetch(
    request => Response.json(new URL(request.url).pathname === '/api/usage' ? USAGE_BODY : BALANCE_BODY),
    () => refreshOllamaUsageProbe(UPSTREAM_ID, config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) })),
  );
  const observed = repo.read();
  assertEquals(observed.usageProbe?.observation?.data.usage, USAGE_BODY);
  assertEquals(observed.usageProbe?.observation?.data.balance, BALANCE_BODY);
  assertEquals(repo.writes.length, 1);
  assertEquals(repo.metrics.map(({ name, labels, value }) => [name, labels, value]), [
    ['balance.usd', { source: 'included' }, 18], ['allowance.usd', { source: 'included' }, 60],
    ['balance.usd', { source: 'purchased' }, 25], ['activity.cost_usd', { range: '7d' }, 3.25],
  ]);

  await withMockedFetch(
    request => new URL(request.url).pathname === failedPath
      ? new Response('invalid credentials', { status: 401 })
      : Response.json({ changed: true }),
    () => expect(refreshOllamaUsageProbe(UPSTREAM_ID, config, async (url, init) => ({ ok: true, value: await directFetcher(url, init) }))).resolves.toMatchObject({ ok: false }),
  );
  const after = repo.read();
  assertEquals(after.usageProbe?.observation, observed.usageProbe?.observation);
  assertEquals(after.usageProbe?.error, `Ollama ${failedPath} returned 401: invalid credentials`);
  assertEquals(repo.writes.length, 2);
  assertEquals(repo.metrics.length, 4);
});

test('records validation failures but propagates parser bugs without persisting an outcome', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();
  const badBalance = Response.json({ included: null });
  const usage = Response.json(USAGE_BODY);
  const result = await refreshOllamaUsageProbe(UPSTREAM_ID, config, async url => ({ ok: true, value: url.endsWith('/api/usage') ? usage : badBalance }));
  expect(result).toMatchObject({ ok: false, error: expect.any(TypeError) });
  expect([usage.bodyUsed, badBalance.bodyUsed, usage.body?.locked, badBalance.body?.locked]).toEqual([true, true, false, false]);
  expect(repo.writes).toHaveLength(1);

  const bug = new TypeError('Ollama usage parser bug');
  const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw bug; });
  try {
    await expect(refreshOllamaUsageProbe(UPSTREAM_ID, config, async url => ({ ok: true, value: Response.json(url.endsWith('/api/usage') ? USAGE_BODY : BALANCE_BODY) }))).rejects.toBe(bug);
    expect(repo.writes).toHaveLength(1);
  } finally {
    parse.mockRestore();
  }
});

test('a rejected write after valid usage reads returns the persistence error', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const cause = new Error('state store unavailable');
  const repo = {
    recordUpstreamMetric: vi.fn(),
    upstreams: { getById: vi.fn(), saveState: vi.fn().mockRejectedValue(cause) },
  };
  const result = await refreshOllamaUsageProbe(UPSTREAM_ID, config,
    async url => ({ ok: true, value: Response.json(url.endsWith('/api/usage') ? USAGE_BODY : BALANCE_BODY) }), repo);
  expect(result).toEqual({ ok: false, error: cause });
  expect(repo.upstreams.saveState).toHaveBeenCalledOnce();
  expect(repo.recordUpstreamMetric).not.toHaveBeenCalled();
});

test('usage is probed when the operator enabled it and a key is configured, and not otherwise', () => {
  const enabled = (config: Record<string, unknown>) =>
    isOllamaUsageEnabled(assertOllamaUpstreamRecord(cloudRecord({ config })).config);

  assertEquals(enabled({ baseUrl: 'https://ollama.com', apiKey: 'k', cloudUsage: true, models: [] }), true);
  // The option is the operator's answer, so it carries an upstream reached
  // through their own domain.
  assertEquals(enabled({ baseUrl: 'https://ollama.example.com', apiKey: 'k', cloudUsage: true, models: [] }), true);
  // No key to authenticate the read with.
  assertEquals(enabled({ baseUrl: 'https://ollama.com', cloudUsage: true, models: [] }), false);
  // The cloud endpoint alone does not turn it on; the stored option does.
  assertEquals(enabled({ baseUrl: 'https://ollama.com', apiKey: 'k', models: [] }), false);
});
