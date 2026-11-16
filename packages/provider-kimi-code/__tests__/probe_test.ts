import { afterEach, expect, test, vi } from 'vitest';

import { account, config, profile, recentState, record, usage } from './fixtures.ts';
import { refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe, runKimiCodeScheduledTask, scheduleKimiCodeProbes } from '../src/probe.ts';
import { readKimiCodeUpstreamState } from '../src/state.ts';
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test.each([false, true])('quota probes preserve the raw current-generation or legacy body (%s) and record percentages', async legacy => {
  const repo = setupRepo();
  const body = usage(legacy);
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.com/coding/v1/usages');
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    expect(request.headers.get('user-agent')).toBeNull();
    return Response.json(body);
  }, async () => {
    const observation = await refreshKimiCodeUsageProbe('up_kimi_code', config, testFetcher);
    expect(observation.data).toEqual(body);
    expect(repo.read().usageProbe).toEqual({ attemptedAt: expect.any(Number), observation, error: null });
    expect(repo.metrics).toEqual([{ name: 'quota.used_percent', value: 25 }, { name: 'quota.used_percent', value: 50 }]);
  });
});

test('account probe stores identity and plan independently from quota', async () => {
  const repo = setupRepo();
  await withMockedFetch(request => {
    expect(request.url.endsWith('/me')).toBe(true);
    return Response.json(profile);
  }, async () => {
    const observation = await refreshKimiCodeAccountProbe('up_kimi_code', config, testFetcher);
    expect(observation.data).toEqual(account);
    expect(repo.read().accountProbe?.observation).toEqual(observation);
    expect(repo.read().usageProbe).toBeNull();
  });
});

test('failed probes retain the last successful observation and propagate the failure', async () => {
  const initial = recentState();
  const repo = setupRepo(initial);
  await withMockedFetch(() => new Response('temporarily unavailable', { status: 503 }), async () => {
    await expect(refreshKimiCodeUsageProbe('up_kimi_code', config, testFetcher)).rejects.toThrow('503');
    await expect(refreshKimiCodeAccountProbe('up_kimi_code', config, testFetcher)).rejects.toThrow('503');
  });
  expect(repo.read().usageProbe?.observation).toEqual(initial.usageProbe?.observation);
  expect(repo.read().accountProbe?.observation).toEqual(initial.accountProbe?.observation);
  expect(repo.read().usageProbe?.error).toContain('temporarily unavailable');
  expect(repo.read().accountProbe?.error).toContain('temporarily unavailable');
  expect(repo.metrics).toHaveLength(0);
});

test('unsaved draft probes issue no persistence or metrics writes', async () => {
  const repo = setupRepo();
  await withMockedFetch(request => Response.json(request.url.endsWith('/usages') ? usage() : profile), async () => {
    await Promise.all([refreshKimiCodeUsageProbe('', config, testFetcher), refreshKimiCodeAccountProbe('', config, testFetcher)]);
  });
  expect(repo.read()).toEqual({ usageProbe: null, accountProbe: null });
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
  await expect(runKimiCodeScheduledTask(record({ state: null, usageRefreshIntervalMinutes: 5 }), { fetcher: async () => fetcher })).rejects.toThrow('scheduled probes');
  expect(repo.read().usageProbe?.observation?.data).toEqual(usage());
  expect(repo.read().accountProbe?.error).toContain('404');
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

test.each([
  { ...profile, nickname: '' },
  { ...profile, user_level_name: '' },
  { user_id: profile.user_id, nickname: profile.nickname, user_level_name: profile.user_level_name },
])('profile parsing accepts zero display values and absent goods version: %j', async body => {
  const repo = setupRepo();
  await withMockedFetch(() => Response.json(body), async () => {
    const observation = await refreshKimiCodeAccountProbe('up_kimi_code', config, testFetcher);
    expect(observation.data).toEqual({ userId: body.user_id, nickname: body.nickname, planName: body.user_level_name });
    expect(repo.read().accountProbe?.observation).toEqual(observation);
  });
});
