import { afterEach, expect, test, vi } from 'vitest';

import { config, profile, recentState, record, usage } from './fixtures.ts';
import { kimiCodeUpstreamModule } from '../src/index.ts';
import { createKimiCodeService, refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe } from '../src/probe.ts';
import { readKimiCodeUpstreamState } from '../src/state.ts';
import { testFetcher, withMockedFetch } from '@floway-dev/test-utils';
import { initUpstreamRuntimeRepo, type Fetcher, type UpstreamRuntimeRepo } from '@floway-dev/upstream';

const setupRepo = (initial: unknown = null) => {
  let state = initial;
  const metrics: Array<{ name: string; value: number }> = [];
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric: async (_id, name, _labels, value) => { metrics.push({ name, value }); },
    upstreams: {
      getById: async () => ({ ...record({ state }), version: 1 }),
      saveState: async (_id, update) => { state = update(state, 1); },
    },
  }));
  return { read: () => readKimiCodeUpstreamState(state), metrics };
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test.each([false, true])('quota probes preserve the raw current-generation or legacy body (%s) and record percentages', async legacy => {
  const repo = setupRepo();
  const body = usage(legacy);
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.com/coding/v1/usages');
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    return Response.json(body);
  }, async () => {
    const observation = await refreshKimiCodeUsageProbe('up_kimi_code', config, testFetcher);
    expect(observation.data).toEqual(body);
    expect(repo.read().usageProbe).toEqual({ attemptedAt: expect.any(Number), observation, error: null });
    expect(repo.metrics).toEqual([{ name: 'quota.used_percent', value: 25 }, { name: 'quota.used_percent', value: 50 }]);
  });
});

test('failed probes retain the last successful observation and propagate the failure', async () => {
  const initial = recentState();
  const repo = setupRepo(initial);
  await withMockedFetch(() => new Response('temporarily unavailable', { status: 503 }), async () => {
    await expect(refreshKimiCodeUsageProbe('up_kimi_code', config, testFetcher)).rejects.toThrow('temporarily unavailable');
    await expect(refreshKimiCodeAccountProbe('up_kimi_code', config, testFetcher)).rejects.toThrow('temporarily unavailable');
  });
  expect(repo.read().usageProbe?.observation).toEqual(initial.usageProbe?.observation);
  expect(repo.read().accountProbe?.observation).toEqual(initial.accountProbe?.observation);
  expect(repo.read().usageProbe?.error).toContain('temporarily unavailable');
  expect(repo.read().accountProbe?.error).toContain('temporarily unavailable');
  expect(repo.metrics).toHaveLength(0);
});

test('older concurrent probes cannot replace newer state or metrics', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const repo = setupRepo();
  let resolveSlow!: (response: Response) => void;
  const slow: Fetcher = () => new Promise(resolve => { resolveSlow = resolve; });
  const first = refreshKimiCodeUsageProbe('up_kimi_code', config, slow);
  await vi.waitFor(() => expect(resolveSlow).toBeTypeOf('function'));
  vi.setSystemTime(2000);
  const newest = usage();
  newest.usages.limit_5h.used_ratio = 0.9;
  await refreshKimiCodeUsageProbe('up_kimi_code', config, async () => Response.json(newest));
  resolveSlow(Response.json(usage()));
  await first;
  expect(repo.read().usageProbe?.observation?.data).toEqual(newest);
  expect(repo.metrics).toHaveLength(2);
});

test('scheduled quota refresh succeeds even when the optional account endpoint fails', async () => {
  const repo = setupRepo();
  const fetcher: Fetcher = async url => url.endsWith('/usages') ? Response.json(usage()) : new Response('profile unavailable', { status: 404 });
  await expect(kimiCodeUpstreamModule.runScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher })).rejects.toThrow(AggregateError);
  expect(repo.read().usageProbe?.observation?.data).toEqual(usage());
  expect(repo.read().accountProbe?.error).toContain('profile unavailable');
});

test('active probes read missing slots and scheduled refresh respects opt-out and due time', async () => {
  setupRepo();
  const calls: string[] = [];
  const fetcher: Fetcher = async url => { calls.push(url); return Response.json(url.endsWith('/usages') ? usage() : profile); };
  await createKimiCodeService().refreshProbes(record().id, config, fetcher, false);
  expect(calls.map(url => new URL(url).pathname).sort()).toEqual(['/coding/v1/me', '/coding/v1/usages']);
  calls.length = 0;
  await kimiCodeUpstreamModule.runScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 0 }), { fetcher: async () => fetcher });
  await kimiCodeUpstreamModule.runScheduledTask(record({ enabled: false, state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher });
  await kimiCodeUpstreamModule.runScheduledTask(record({ usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher });
  await kimiCodeUpstreamModule.runScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => null });
  expect(calls).toHaveLength(0);
});

test('probe errors preserve the network error and any persistence failure', async () => {
  const network = new Error('network failed');
  const disk = new Error('write failed');
  initUpstreamRuntimeRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => ({ ...record(), version: 1 }), saveState: async () => { throw disk; } } }));
  try {
    await refreshKimiCodeUsageProbe('up_kimi_code', config, () => Promise.reject(network));
    throw new Error('Expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([network, disk]);
  }
});

test('active refresh uses current cadence and deduplicates concurrent forced reads', async () => {
  const id = 'up_kimi_code';
  let state: unknown = recentState();
  const metrics: number[] = [];
  const repo: UpstreamRuntimeRepo = {
    recordUpstreamMetric: async (_id, _name, _labels, value) => { metrics.push(value); },
    upstreams: {
      getById: async () => ({ ...record({ state }), version: 3 }),
      saveState: async (_id, update) => { state = update(state, 3); },
    },
  };
  const service = createKimiCodeService(() => repo);
  const fetched = Promise.withResolvers<Response>();
  const calls: string[] = [];
  const fetcher: Fetcher = async url => { calls.push(url); return await fetched.promise; };
  await service.refreshProbes(id, config, fetcher, false);
  expect(calls).toEqual([]);
  const first = service.refreshProbes(id, config, fetcher, true);
  const second = service.refreshProbes(id, config, fetcher, true);
  await vi.waitFor(() => expect(calls).toEqual(['https://api.kimi.com/coding/v1/usages']));
  const newest = usage();
  newest.usages.limit_5h.used_ratio = 0.9;
  fetched.resolve(Response.json(newest));
  await Promise.all([first, second]);
  expect(readKimiCodeUpstreamState(state).usageProbe?.observation?.data).toEqual(newest);
  expect(metrics).toEqual([90, 50]);
  expect(calls).toHaveLength(1);
});

test('active refresh keeps the configuration version bound through quota persistence', async () => {
  const id = 'up_kimi_code';
  const initial = recentState();
  let state: unknown = initial;
  let version = 3;
  const repo: UpstreamRuntimeRepo = {
    recordUpstreamMetric: async () => { throw new Error('Unexpected quota metric'); },
    upstreams: {
      getById: async () => ({ ...record({ state }), version }),
      saveState: async (_id, update) => { state = update(state, version); },
    },
  };
  const service = createKimiCodeService(() => repo);
  const fetchStarted = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const refresh = service.refreshProbes(id, config, async () => { fetchStarted.resolve(); return await response.promise; }, true);
  await fetchStarted.promise;
  version++;
  response.resolve(Response.json(usage()));
  await refresh;
  expect(state).toBe(initial);
});

test('an oversized probe body cancels its source with the original error', async () => {
  const cancelled: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel(error) { cancelled.push(error); },
  });
  const result = await refreshKimiCodeUsageProbe('', config, async () => new Response(body)).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(RangeError);
  expect(result).toHaveProperty('message', 'Kimi Code /usages response exceeds 1048576 bytes');
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]).toBe(result);
});
