import { beforeEach, describe, expect, test, vi } from 'vitest';

import { clearInFlightForTesting, fetchUpstreamModelsCached, MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { directFetcher, type Provider, type ProviderModel, type UpstreamModelsCache } from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_a';

const aModel = (id: string): ProviderModel => stubProviderModel({ id });

// The SWR check reads the stored catalog off the provider instance, which the
// registry mirrors from the row that produced it — so a seeded catalog is
// handed to both the repo and the instance here.
const stubInstance = (
  fetchFn: () => Promise<ProviderModel[]>,
  modelsCache: UpstreamModelsCache | null = null,
): Provider => ({
  upstreamId: UPSTREAM_ID,
  kind: 'custom',
  name: UPSTREAM_ID,
  inboundHeaderAllowlist: [],
  disabledPublicModelIds: [],
  modelPrefix: null,
  modelsCache,
  instance: stubProvider({ getProvidedModels: fetchFn }),
});

// The cache lives on the upstream row, so every write needs a row to
// land on.
const setupRepo = async (): Promise<InMemoryRepo> => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.upstreams.save({
    id: UPSTREAM_ID,
    kind: 'custom',
    name: 'Upstream A',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    config: {},
    state: null,
    modelsCache: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    hue: 210,
  });
  return repo;
};

const seedCache = async (
  repo: InMemoryRepo,
  cache: { revision: number; fetchedAt: number; models: ProviderModel[] },
): Promise<UpstreamModelsCache> => {
  await repo.upstreams.saveModelsCache(UPSTREAM_ID, cache);
  const stored = (await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache;
  if (!stored) throw new Error('the seeded catalog did not land on the upstream row');
  return stored;
};

const storedCache = async (repo: InMemoryRepo): Promise<UpstreamModelsCache | null> =>
  (await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache ?? null;

beforeEach(() => {
  clearInFlightForTesting();
});

describe('fetchUpstreamModelsCached', () => {
  test('cold cache: fetches, stores, returns models', async () => {
    const repo = await setupRepo();
    const fetchFn = vi.fn(async () => [aModel('m1')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['m1']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.models.map(m => m.id)).toEqual(['m1']);
  });

  test('within SOFT: no fetch, returns stored', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 1000, models: [aModel('cached')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['cached']);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('past SOFT within HARD: returns stored + schedules revalidate', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    let scheduled: Promise<unknown> | null = null;

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: p => { scheduled = p; }, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['stale']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduled).not.toBeNull();
    await scheduled!;
    expect((await storedCache(repo))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('past HARD: blocks on fetch', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 25 * 60 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  // The instance carries the row as it was read at request start, and a
  // request reaches this function once per alias target resolved. Without the
  // write-back the second resolution would still see the stale snapshot and
  // refetch, which the repo read used to prevent.
  test('a fetch updates the instance so a later call in the same request is a cache hit', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 25 * 60 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    const instance = stubInstance(fetchFn, cache);

    const first = await fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher });
    const second = await fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher });

    expect(first.map(m => m.id)).toEqual(['fresh']);
    expect(second.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('force=true: bypasses cache and blocks on fetch', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );

    expect(result.map(m => m.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.models.map(m => m.id)).toEqual(['fresh']);
  });

  test('two concurrent cold callers join one fetch', async () => {
    await setupRepo();
    let resolveFetch: ((v: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(r => { resolveFetch = r; }));
    const instance = stubInstance(fetchFn);

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
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });
    let scheduled: Promise<unknown> | null = null;

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: p => { scheduled = p; }, fetcher: directFetcher },
    );

    expect(result.map(m => m.id)).toEqual(['stale']);
    expect(scheduled).not.toBeNull();
    await scheduled!;
    const stored = await storedCache(repo);
    expect(stored?.models.map(m => m.id)).toEqual(['stale']);
    expect(stored?.lastError?.message).toContain('boom');
  });

  test('cold + fetch failure: throws and writes nothing', async () => {
    const repo = await setupRepo();
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });

    await expect(fetchUpstreamModelsCached(
      stubInstance(fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    )).rejects.toThrow('boom');

    expect(await storedCache(repo)).toBeNull();
  });

  test('force=true + fetch failure: throws (no fallback) and annotates lastError', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });

    await expect(fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    )).rejects.toThrow('boom');

    const stored = await storedCache(repo);
    expect(stored?.models.map(m => m.id)).toEqual(['stored']);
    expect(stored?.lastError?.message).toContain('boom');
  });

  test('catalog revision mismatch bypasses a soft-fresh stored row', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, {
      revision: MODEL_CATALOG_REVISION - 1,
      fetchedAt: Date.now() - 1000,
      models: [aModel('old-catalog')],
    });
    const fetchFn = vi.fn(async () => [aModel('current-catalog')]);

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: () => {}, fetcher: directFetcher },
    );

    expect(result.map(model => model.id)).toEqual(['current-catalog']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.revision).toBe(MODEL_CATALOG_REVISION);
  });
});
