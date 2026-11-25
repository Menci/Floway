import { afterEach, expect, test, vi } from 'vitest';

import { config, profile, recentState, record, usage } from './fixtures.ts';
import { refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe, runKimiCodeScheduledTask, scheduleKimiCodeProbes, type KimiCodeProbeFetcher } from '../src/probe.ts';
import { createKimiCodeService } from '../src/service.ts';
import { readKimiCodeUpstreamState } from '../src/state.ts';
import { kimiCodeUpstreamFact } from '../src/upstream-fact.ts';
import { initProviderRepo, type Fetcher } from '@floway-dev/provider';
import { testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const setupRepo = (initial: unknown = null) => {
  let state = initial;
  const metrics: Array<{ name: string; value: number }> = [];
  initProviderRepo(() => ({
    recordUpstreamMetric: async (_id, name, _labels, value) => { metrics.push({ name, value }); },
    upstreams: {
      getById: async () => ({ ...record({ state }), configVersion: 1 }),
      saveState: async (_id, update) => { state = update(state, 1); },
    },
  }));
  return { read: () => readKimiCodeUpstreamState(state), metrics };
};

test('the service defers to fresh persisted state and coalesces forced usage probes', async () => {
  const repo = setupRepo(recentState());
  const service = createKimiCodeService();
  const upstream = kimiCodeUpstreamFact(record());
  const network = Promise.withResolvers<Awaited<ReturnType<KimiCodeProbeFetcher>>>();
  const fetcher = vi.fn<KimiCodeProbeFetcher>().mockReturnValue(network.promise);

  await expect(service.observeResponse(upstream, 200, fetcher)).resolves.toEqual({ persisted: true });
  expect(fetcher).not.toHaveBeenCalled();

  const first = service.observeResponse(upstream, 429, fetcher);
  const second = service.observeResponse(upstream, 403, fetcher);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.kimi.com/coding/v1/usages',
    expect.objectContaining({ method: 'GET' }),
  ));
  const reading = usage();
  reading.usages.limit_5h.used_ratio = 0.75;
  network.resolve({ ok: true, value: Response.json(reading) });
  await expect(Promise.all([first, second])).resolves.toEqual([{ persisted: true }, { persisted: true }]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(repo.read().usageProbe?.observation?.data).toEqual(reading);
});

test('a probe transport failure returns a persistence result with the original error', async () => {
  const initial = recentState();
  const repo = setupRepo(initial);
  const cause = new Error('Kimi connection closed');
  const result = await createKimiCodeService().observeResponse(kimiCodeUpstreamFact(record()), 429,
    async () => ({ ok: false, error: { kind: 'transport', cause } }));
  expect(result).toMatchObject({ persisted: false, error: expect.objectContaining({ errors: [cause] }) });
  expect(repo.read().usageProbe?.observation).toEqual(initial.usageProbe?.observation);
  expect(repo.read().usageProbe?.error).toBe(cause.message);
});

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
  await expect(runKimiCodeScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher })).rejects.toThrow(AggregateError);
  expect(repo.read().usageProbe?.observation?.data).toEqual(usage());
  expect(repo.read().accountProbe?.error).toContain('profile unavailable');
});

test('request-time debounce, opt-out and scheduled intervals issue only due reads', async () => {
  setupRepo();
  const calls: string[] = [];
  const fetcher: Fetcher = async url => { calls.push(url); return Response.json(url.endsWith('/usages') ? usage() : profile); };
  const background: Promise<unknown>[] = [];
  scheduleKimiCodeProbes(record(), config, fetcher, promise => { background.push(promise); }, false);
  expect(background).toHaveLength(0);
  scheduleKimiCodeProbes(record({ state: null }), config, fetcher, promise => { background.push(promise); }, false);
  await Promise.all(background);
  expect(calls.map(url => new URL(url).pathname).sort()).toEqual(['/coding/v1/me', '/coding/v1/usages']);
  calls.length = 0;
  await runKimiCodeScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 0 }), { fetcher: async () => fetcher });
  await runKimiCodeScheduledTask(record({ enabled: false, state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher });
  await runKimiCodeScheduledTask(record({ usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher });
  await runKimiCodeScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => null });
  expect(calls).toHaveLength(0);
});

test('probe errors preserve the network error and any persistence failure', async () => {
  const network = new Error('network failed');
  const disk = new Error('write failed');
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => ({ ...record(), configVersion: 1 }), saveState: async () => { throw disk; } } }));
  try {
    await refreshKimiCodeUsageProbe('up_kimi_code', config, () => Promise.reject(network));
    throw new Error('Expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([network, disk]);
  }
});
