import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearInFlightForTesting, fetchUpstreamModelsCached, MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import type { GatewayProvider } from '../../../src/data-plane/providers/registry.ts';
import { initRepo } from '../../../src/repo/index.ts';
import type { ModelsCacheGeneration } from '../../../src/repo/types.ts';
import { serializeStoredConfig } from '../../../src/repo/upstream-json.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { directFetcher, type ProviderModel, type UpstreamModelsCache } from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_a';
const CACHE_GENERATION = vi.hoisted<ModelsCacheGeneration>(() => ({
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { identity: 'old' },
}));

const aModel = (id: string): ProviderModel => stubProviderModel({ id });

// The SWR check reads the stored catalog off the provider instance, which the
// registry mirrors from the row that produced it — so a seeded catalog is
// handed to both the repo and the instance here.
const stubInstance = (
  fetchFn: () => Promise<ProviderModel[]>,
  modelsCache: UpstreamModelsCache | null = null,
  generation: ModelsCacheGeneration = CACHE_GENERATION,
  fetchIdentity = serializeStoredConfig(generation.config),
): GatewayProvider => ({
  upstreamId: UPSTREAM_ID,
  kind: 'custom',
  name: UPSTREAM_ID,
  inboundHeaderAllowlist: [],
  disabledPublicModelIds: [],
  modelPrefix: null,
  modelsCache,
  instance: stubProvider({ getProvidedModels: fetchFn }),
  modelsCacheGeneration: generation,
  modelsFetchIdentity: fetchIdentity,
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
    updatedAt: CACHE_GENERATION.updatedAt,
    config: CACHE_GENERATION.config,
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
  await repo.upstreams.saveModelsCache(UPSTREAM_ID, CACHE_GENERATION, cache);
  const stored = (await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache;
  if (!stored) throw new Error('the seeded catalog did not land on the upstream row');
  return stored;
};

const storedCache = async (repo: InMemoryRepo): Promise<UpstreamModelsCache | null> =>
  (await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache ?? null;

beforeEach(() => {
  clearInFlightForTesting();
});

afterEach(() => {
  vi.useRealTimers();
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

  test('rejects duplicate non-empty model ids before they can enter the cache', async () => {
    const repo = await setupRepo();
    const fetchFn = vi.fn(async () => [aModel('duplicate'), aModel('duplicate')]);

    await expect(fetchUpstreamModelsCached(
      stubInstance(fetchFn),
      { scheduler: () => {}, fetcher: directFetcher },
    )).rejects.toThrow("Upstream 'up_a' returned duplicate model id 'duplicate'");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await storedCache(repo)).toBeNull();
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

  test('a timed-out cold flight leaves the in-flight slot reusable', async () => {
    vi.useFakeTimers();
    const repo = await setupRepo();
    const stalledResult = Promise.withResolvers<ProviderModel[]>();
    const stalledFetch = vi.fn(() => stalledResult.promise);
    const stalled = fetchUpstreamModelsCached(
      stubInstance(stalledFetch),
      { scheduler: () => {}, fetcher: directFetcher },
    );
    const rejection = stalled.catch(error => error as unknown);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await rejection).toMatchObject({ name: 'TimeoutError' });
    const succeedingFetch = vi.fn(async () => [aModel('recovered')]);
    const recovered = await fetchUpstreamModelsCached(
      stubInstance(succeedingFetch),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );
    expect(recovered.map(model => model.id)).toEqual(['recovered']);
    expect(stalledFetch).toHaveBeenCalledTimes(1);
    expect(succeedingFetch).toHaveBeenCalledTimes(1);
    stalledResult.resolve([aModel('late-old-model')]);
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['recovered']);
  });

  test('a timed-out fetch cannot attach a later failure to its recovery flight', async () => {
    vi.useFakeTimers();
    const repo = await setupRepo();
    const stalledResult = Promise.withResolvers<ProviderModel[]>();
    const stalled = fetchUpstreamModelsCached(
      stubInstance(vi.fn(() => stalledResult.promise)),
      { scheduler: () => {}, fetcher: directFetcher },
    );
    const rejection = stalled.catch(error => error as unknown);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await rejection).toMatchObject({ name: 'TimeoutError' });
    const recovered = await fetchUpstreamModelsCached(
      stubInstance(vi.fn(async () => [aModel('recovered')])),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );
    expect(recovered.map(model => model.id)).toEqual(['recovered']);
    stalledResult.reject(new Error('late old failure'));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    const stored = await storedCache(repo);
    expect(stored?.models.map(model => model.id)).toEqual(['recovered']);
    expect(stored?.lastError).toBeNull();
  });

  test('a stalled successful persistence leaves the in-flight slot reusable', async () => {
    vi.useFakeTimers();
    const repo = await setupRepo();
    const originalSave = repo.upstreams.saveModelsCache.bind(repo.upstreams);
    const saveGate = Promise.withResolvers<void>();
    const lateSaveFinished = Promise.withResolvers<void>();
    const save = vi.spyOn(repo.upstreams, 'saveModelsCache').mockImplementation(async (id, generation, cache) => {
      await saveGate.promise;
      await originalSave(id, generation, cache);
      lateSaveFinished.resolve();
      return true;
    });
    const stalled = fetchUpstreamModelsCached(
      stubInstance(vi.fn(async () => [aModel('first')])),
      { scheduler: () => {}, fetcher: directFetcher },
    );
    const rejection = stalled.catch(error => error as unknown);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await rejection).toMatchObject({ name: 'TimeoutError' });
    save.mockRestore();
    const recovered = await fetchUpstreamModelsCached(
      stubInstance(vi.fn(async () => [aModel('recovered')])),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );
    expect(recovered.map(model => model.id)).toEqual(['recovered']);
    saveGate.resolve();
    await lateSaveFinished.promise;
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['recovered']);
  });

  test('a stalled error persistence leaves the in-flight slot reusable', async () => {
    vi.useFakeTimers();
    const repo = await setupRepo();
    const originalSaveError = repo.upstreams.saveModelsCacheError.bind(repo.upstreams);
    const saveGate = Promise.withResolvers<void>();
    const lateSaveFinished = Promise.withResolvers<void>();
    const saveError = vi.spyOn(repo.upstreams, 'saveModelsCacheError').mockImplementation(async (id, generation, error) => {
      await saveGate.promise;
      await originalSaveError(id, generation, error);
      lateSaveFinished.resolve();
      return true;
    });
    const stalled = fetchUpstreamModelsCached(
      stubInstance(vi.fn(async () => { throw new Error('catalog failed'); })),
      { scheduler: () => {}, fetcher: directFetcher },
    );
    const rejection = stalled.catch(error => error as unknown);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await rejection).toMatchObject({ name: 'TimeoutError' });
    saveError.mockRestore();
    const recovered = await fetchUpstreamModelsCached(
      stubInstance(vi.fn(async () => [aModel('recovered')])),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );
    expect(recovered.map(model => model.id)).toEqual(['recovered']);
    saveGate.resolve();
    await lateSaveFinished.promise;
    const stored = await storedCache(repo);
    expect(stored?.models.map(model => model.id)).toEqual(['recovered']);
    expect(stored?.lastError).toBeNull();
  });

  test('concurrent stale callers schedule one revalidation and refresh every joining provider instance', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 20 * 60_000, models: [aModel('stale')] });
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const firstInstance = stubInstance(fetchFn, cache);
    const secondInstance = stubInstance(fetchFn, cache);
    const scheduled: Promise<unknown>[] = [];
    const scheduler = (promise: Promise<unknown>) => { scheduled.push(promise); };

    const [first, second] = await Promise.all([
      fetchUpstreamModelsCached(firstInstance, { scheduler, fetcher: directFetcher }),
      fetchUpstreamModelsCached(secondInstance, { scheduler, fetcher: directFetcher }),
    ]);

    expect(first.map(model => model.id)).toEqual(['stale']);
    expect(second.map(model => model.id)).toEqual(['stale']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);

    resolveFetch!([aModel('fresh')]);
    await Promise.all(scheduled);

    expect(firstInstance.modelsCache?.models.map(model => model.id)).toEqual(['fresh']);
    expect(secondInstance.modelsCache?.models.map(model => model.id)).toEqual(['fresh']);
    expect((await fetchUpstreamModelsCached(secondInstance, { scheduler, fetcher: directFetcher })).map(model => model.id)).toEqual(['fresh']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
  });

  test('a superseded generation neither joins nor overwrites the current catalog', async () => {
    const repo = await setupRepo();
    let resolveOld: ((models: ProviderModel[]) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveOld = resolve; }));
    const oldRequest = fetchUpstreamModelsCached(
      stubInstance(oldFetch, null, CACHE_GENERATION, 'same-fetch'),
      { scheduler: () => {}, fetcher: directFetcher },
    );
    await Promise.resolve();

    const nextGeneration = { updatedAt: CACHE_GENERATION.updatedAt, config: { identity: 'new' } };
    const current = await repo.upstreams.getById(UPSTREAM_ID);
    if (!current) throw new Error('upstream row missing');
    await repo.upstreams.saveClearingModelsCache({ ...current, updatedAt: nextGeneration.updatedAt, config: nextGeneration.config });
    const newFetch = vi.fn(async () => [aModel('new-tenant-model')]);
    const newRequest = fetchUpstreamModelsCached(
      stubInstance(newFetch, null, nextGeneration, 'same-fetch'),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );

    expect((await newRequest).map(model => model.id)).toEqual(['new-tenant-model']);
    resolveOld!([aModel('old-tenant-model')]);
    expect((await oldRequest).map(model => model.id)).toEqual(['old-tenant-model']);
    expect(oldFetch).toHaveBeenCalledTimes(1);
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['new-tenant-model']);
  });

  test('drafts with one persistence generation but different fetch identities do not join', async () => {
    await setupRepo();
    const firstFetch = vi.fn(async () => [aModel('first-draft-model')]);
    const secondFetch = vi.fn(async () => [aModel('second-draft-model')]);

    const [first, second] = await Promise.all([
      fetchUpstreamModelsCached(stubInstance(firstFetch, null, CACHE_GENERATION, 'first-draft'), { scheduler: () => {}, fetcher: directFetcher, force: true }),
      fetchUpstreamModelsCached(stubInstance(secondFetch, null, CACHE_GENERATION, 'second-draft'), { scheduler: () => {}, fetcher: directFetcher, force: true }),
    ]);

    expect(first.map(model => model.id)).toEqual(['first-draft-model']);
    expect(second.map(model => model.id)).toEqual(['second-draft-model']);
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
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
