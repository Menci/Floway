import { expect, test, vi } from 'vitest';

import { callOllama, ollamaInput, ollamaServices, settledProbes } from './pipeline-fixture.ts';
import { CREDIT_BALANCE as BALANCE_BODY, USAGE_TOTALS as USAGE_BODY } from './usage-fixture.ts';
import { assertOllamaUpstreamRecord } from '../src/config.ts';
import { ollamaPipelines } from '../src/index.ts';
import { readOllamaUpstreamState } from '../src/state.ts';
import {
  OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS,
  isOllamaUsageEnabled,
  refreshOllamaUsageProbe,
} from '../src/usage-probe.ts';
import { run, type RunEvent } from '@floway-dev/pipeline';
import { directFetcher, initProviderRepo, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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
  const reads: string[] = [];
  const writes: unknown[] = [];
  const metrics: Array<{ name: string; labels: Record<string, string | number | boolean | null>; value: number; timestamp: number }> = [];
  initProviderRepo(() => ({
    recordUpstreamMetric: async (_upstreamId, name, labels, value, timestamp) => { metrics.push({ name, labels: { ...labels }, value, timestamp }); },
    upstreams: {
      getById: async id => {
        reads.push(id);
        return { ...cloudRecord(), state: current, configVersion: 1 };
      },
      saveState: async (_id, mutate) => {
        current = mutate(current, 1);
        writes.push(current);
      },
    },
  }));
  return { read: () => readOllamaUpstreamState(current), replace: (value: unknown) => { current = value; }, reads, writes, metrics };
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

test('a synchronous usage fetch failure still dispatches the paired balance read', async () => {
  const { config } = assertOllamaUpstreamRecord(cloudRecord());
  const repo = withStateRepo();
  const error = new Error('usage transport failed');
  const paths: string[] = [];
  const fetcher: Fetcher = url => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/api/usage') throw error;
    return Promise.resolve(Response.json(BALANCE_BODY));
  };
  await expect(refreshOllamaUsageProbe(UPSTREAM_ID, config, fetcher)).rejects.toBe(error);
  expect(paths).toEqual(['/api/usage', '/api/balance']);
  expect(repo.read().usageProbe?.error).toBe(error.message);
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

test('an inference call arms the probe, and the stored attempt time debounces the next one', async () => {
  const repo = withStateRepo();
  const paths: string[] = [];
  const services = ollamaServices(async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    switch (path) {
    case '/api/usage': return Response.json(USAGE_BODY);
    case '/api/balance': return Response.json(BALANCE_BODY);
    case '/api/me': return Response.json({ Plan: 'free' });
    case '/v1/chat/completions': return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    default: throw new Error(`Unexpected request ${url}`);
    }
  });
  const input = ollamaInput(cloudRecord(), stubProviderModel({ upstreamModelId: 'gpt-oss:120b' }), { messages: [] });
  const callChat = async () => {
    const events: RunEvent[] = [];
    paths.length = 0;
    await callOllama(ollamaPipelines.openaiChatCompletions, input, services, event => events.push(event));
    return settledProbes(events).find(({ name }) => name === 'ollama.usageProbe')?.result;
  };

  expect(await callChat()).toMatchObject({ ok: true, value: { persisted: true } });
  expect(paths).toEqual(['/v1/chat/completions', '/api/usage', '/api/balance', '/api/me']);

  expect(await callChat()).toBeUndefined();
  expect(paths).toEqual(['/v1/chat/completions']);

  const stale = { usageProbe: { attemptedAt: Date.now() - OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS, observation: null, error: null } };
  repo.replace({ ...repo.read(), ...stale });
  expect(await callChat()).toMatchObject({ ok: true, value: { persisted: true } });
  expect(paths).toEqual(['/v1/chat/completions', '/api/usage', '/api/balance']);
  expect(repo.reads).toEqual([UPSTREAM_ID, UPSTREAM_ID, UPSTREAM_ID]);
});

test('a rate limit and a failed usage probe both settle as values', async () => {
  const repo = withStateRepo();
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
  const events: RunEvent[] = [];
  const probe = (name: string) => settledProbes(events).find(event => event.name === name);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const handle = run(ollamaPipelines.openaiChatCompletions, ollamaInput(cloudRecord(), stubProviderModel(), { messages: [] }), {
    services: ollamaServices(fetcher), finalizationTimeoutMs: 1_000, events: event => events.push(event),
  });
  try {
    const result = await handle.result;
    expect(result['response.http'].status).toBe(429);
    expect(result['response.openaiChatCompletions']).toEqual({
      kind: 'error', source: 'upstream', error: { error: { type: 'upstream_error', message: 'rate limit' } },
    });
    await vi.waitFor(() => expect(probe('ollama.accountProbe')?.result).toMatchObject({ ok: true, value: { persisted: true } }));
    expect(probe('ollama.usageProbe')).toEqual({ name: 'ollama.usageProbe', result: undefined });
    expect(events.some(event => event.k === 'done')).toBe(false);
    balance.resolve(new Response('probe denied', { status: 401 }));
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(probe('ollama.usageProbe')?.result).toMatchObject({
      ok: true, value: { persisted: false, error: { message: 'Ollama /api/balance returned 401: probe denied' } },
    });
    expect(repo.read().usageProbe?.error).toBe('Ollama /api/balance returned 401: probe denied');
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    balance.resolve(new Response('probe denied', { status: 401 }));
    await handle.done;
    warning.mockRestore();
  }
});
