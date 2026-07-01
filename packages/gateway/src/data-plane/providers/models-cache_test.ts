import { beforeEach, describe, expect, test, vi } from 'vitest';

import { clearInFlightForTesting, fetchUpstreamModelsCached } from './models-cache.ts';
import { initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { directFetcher, type Provider, type ProviderModel } from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const aModel = (id: string): ProviderModel => stubProviderModel({ id });

const stubInstance = (
  upstreamId: string,
  fetchFn: () => Promise<ProviderModel[]>,
): Provider => ({
  upstream: upstreamId,
  kind: 'custom',
  name: upstreamId,
  disabledPublicModelIds: [],
  modelPrefix: null,
  supportsResponsesItemReference: false,
  instance: stubProvider({ getProvidedModels: fetchFn }),
});

const setupRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

beforeEach(() => {
  clearInFlightForTesting();
});

describe('fetchUpstreamModelsCached', () => {
  test('cold cache: fetches, stores, returns models', async () => {
    const repo = setupRepo();
    const fetchFn = vi.fn(async () => [aModel('m1')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['m1']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const row = await repo.modelsCache.get('up_a');
    expect(row?.models.map(m => m.id)).toEqual(['m1']);
  });

  test('within SOFT: no fetch, returns stored', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 1000, models: [aModel('cached')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['cached']);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('past SOFT within HARD: returns stored + schedules revalidate', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    let scheduled: Promise<unknown> | null = null;

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: p => { scheduled = p; }, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['stale']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduled).not.toBeNull();
    await scheduled!;
    expect((await repo.modelsCache.get('up_a'))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('past HARD: blocks on fetch', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 25 * 60 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await repo.modelsCache.get('up_a'))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('force=true: bypasses cache and blocks on fetch', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );

    expect(result.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await repo.modelsCache.get('up_a'))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('two concurrent cold callers join one fetch', async () => {
    setupRepo();
    let resolveFetch: ((v: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(r => { resolveFetch = r; }));
    const instance = stubInstance('up_a', fetchFn);

    const p1 = fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher });
    const p2 = fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher });

    // Yield once so both calls reach the L1 lookup before we resolve the fetch.
    await Promise.resolve();
    resolveFetch!([aModel('m1')]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.map(m => m.id)).toEqual(['m1']);
    expect(r2.map(m => m.id)).toEqual(['m1']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('background revalidate failure preserves stored row and writes lastError', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });
    let scheduled: Promise<unknown> | null = null;

    const result = await fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: p => { scheduled = p; }, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['stale']);
    expect(scheduled).not.toBeNull();
    await scheduled!;
    const row = await repo.modelsCache.get('up_a');
    expect(row?.models.map(m => m.id)).toEqual(['stale']);
    expect(row?.lastError?.message).toContain('boom');
  });

  test('cold + fetch failure: throws and writes nothing', async () => {
    const repo = setupRepo();
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });

    await expect(fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    )).rejects.toThrow('boom');

    expect(await repo.modelsCache.get('up_a')).toBeNull();
  });

  test('force=true + fetch failure: throws (no fallback) and annotates lastError', async () => {
    const repo = setupRepo();
    await repo.modelsCache.put('up_a', { fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });

    await expect(fetchUpstreamModelsCached(
      stubInstance('up_a', fetchFn),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    )).rejects.toThrow('boom');

    const row = await repo.modelsCache.get('up_a');
    expect(row?.models.map(m => m.id)).toEqual(['stored']);
    expect(row?.lastError?.message).toContain('boom');
  });
});
