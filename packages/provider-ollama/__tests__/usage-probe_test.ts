import { expect, test, vi } from 'vitest';

import { callOllama, ollamaInput } from './pipeline-fixture.ts';
import { CREDIT_BALANCE as BALANCE_BODY, USAGE_TOTALS as USAGE_BODY } from './usage-fixture.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { createOllamaProvider } from '../src/provider.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import {
  OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS,
  isOllamaUsageEnabled,
  refreshOllamaUsageProbe,
} from '../src/usage-probe.ts';
import { isDeferred, run } from '@floway-dev/pipeline';
import { directFetcher, initProviderRepo, readHttpBody, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertExists, assertRejects, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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
    () => refreshOllamaUsageProbe(UPSTREAM_ID, config, directFetcher),
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
    () => assertRejects(() => refreshOllamaUsageProbe(UPSTREAM_ID, config, directFetcher)),
  );
  const after = repo.read();
  assertEquals(after.usageProbe?.observation, observed.usageProbe?.observation);
  assertEquals(after.usageProbe?.error, `Ollama ${failedPath} returned 401: invalid credentials`);
  assertEquals(repo.writes.length, 2);
  assertEquals(repo.metrics.length, 4);
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

// Drives the provider rather than the probe helpers so the arming decision —
// which call consumes the account's windows, and what the debounce reads — is
// exercised where it is made.
const callChat = async (record: UpstreamRecord, onUsageProbe: (path: string) => void): Promise<void> => {
  const provider = createOllamaProvider(record);
  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/usage' || path === '/api/balance') {
        onUsageProbe(path);
        return Response.json(path === '/api/usage' ? USAGE_BODY : BALANCE_BODY);
      }
      if (path === '/api/me') return Response.json({ Plan: 'free' });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    async () => {
      await callOllama(
        provider.pipelines.openaiChatCompletions,
        ollamaInput(stubProviderModel({ upstreamModelId: 'gpt-oss:120b' }), { messages: [] }),
      );
    },
  );
};

test('an inference call arms the probe, and the stored attempt time debounces the next one', async () => {
  withStateRepo();
  const probes: string[] = [];
  await callChat(cloudRecord(), path => { probes.push(path); });
  assertEquals(probes, ['/api/usage', '/api/balance']);

  const justProbed = { usageProbe: { attemptedAt: Date.now(), observation: null, error: null } };
  await callChat(cloudRecord({ state: justProbed }), path => { probes.push(path); });
  assertEquals(probes.length, 2);

  const stale = { usageProbe: { attemptedAt: Date.now() - OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS, observation: null, error: null } };
  await callChat(cloudRecord({ state: stale }), path => { probes.push(path); });
  assertEquals(probes, ['/api/usage', '/api/balance', '/api/usage', '/api/balance']);
});

test('a rate-limited response preserves its body and a failed usage probe settles as data', async () => {
  const repo = withStateRepo();
  const { pipelines } = createOllamaProvider(cloudRecord());
  assertExists(pipelines.openaiChatCompletions);
  const balance = Promise.withResolvers<Response>();
  const fetcher: Fetcher = async url => {
    switch (new URL(url).pathname) {
    case '/v1/chat/completions': return new Response('rate limit', { status: 429 });
    case '/api/usage': return Response.json(USAGE_BODY);
    case '/api/balance': return await balance.promise;
    case '/api/me': return Response.json({ Plan: 'free' });
    default: throw new Error(`Unexpected request ${url}`);
    }
  };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const handle = run(pipelines.openaiChatCompletions, ollamaInput(stubProviderModel(), { messages: [] }), {
      services: { fetcher: () => fetcher }, finalizationTimeoutMs: 1_000,
    });
    const result = await handle.result;
    expect(result['response.http'].status).toBe(429);
    expect((await readHttpBody(result['response.http'].body)).utf8()).toBe('rate limit');
    const usage = 'response.provider.usageProbe' in result && result['response.provider.usageProbe'];
    const account = 'response.provider.accountProbe' in result && result['response.provider.accountProbe'];
    if (!isDeferred(usage) || !isDeferred(account)) throw new Error('Expected usage and account deferreds');
    expect(usage.name).toBe('ollama.usageProbe');
    expect(account.name).toBe('ollama.accountProbe');
    const done = vi.fn();
    void handle.done.then(done);
    await expect(account.promise).resolves.toEqual({ persisted: true });
    expect(done).not.toHaveBeenCalled();
    balance.resolve(new Response('probe denied', { status: 401 }));
    await expect(usage.promise).resolves.toMatchObject({ persisted: false, error: { message: 'Ollama /api/balance returned 401: probe denied' } });
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(repo.read().usageProbe?.error).toBe('Ollama /api/balance returned 401: probe denied');
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
  }
});
