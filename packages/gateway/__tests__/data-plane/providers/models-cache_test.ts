import { beforeEach, describe, expect, test, vi } from 'vitest';

import { clearInFlightForTesting, fetchUpstreamModelsCached, MODEL_CATALOG_REVISION, warmUpstreamModels } from '../../../src/data-plane/providers/models-cache.ts';
import type { GatewayProvider } from '../../../src/data-plane/providers/registry.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { SqlRepo } from '../../../src/repo/sql.ts';
import type { ModelsCacheGeneration } from '../../../src/repo/types.ts';
import { serializeStoredConfig } from '../../../src/repo/upstream-json.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import { directFetcher, type ProviderModel, type UpstreamModelsCache } from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_a';
const CACHE_GENERATION = vi.hoisted<ModelsCacheGeneration>(() => ({
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { identity: 'old' },
}));

const aModel = (id: string): ProviderModel => stubProviderModel({ id });

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
  await seedModelsCache(repo.upstreams, UPSTREAM_ID, CACHE_GENERATION, cache);
  const stored = (await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache;
  if (!stored) throw new Error('the seeded catalog did not land on the upstream row');
  return stored;
};

const storedCache = async (repo: InMemoryRepo): Promise<UpstreamModelsCache | null> =>
  (await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache ?? null;

const captureScheduled = () => {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    scheduler: (promise: Promise<unknown>): void => { promises.push(promise); },
  };
};

beforeEach(() => {
  vi.restoreAllMocks();
  clearInFlightForTesting();
});

describe('fetchUpstreamModelsCached', () => {
  test('cold cache returns immediately and refreshes in the background', async () => {
    const repo = await setupRepo();
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const scheduled = captureScheduled();

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result).toEqual([]);
    expect(scheduled.promises).toHaveLength(1);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    resolveFetch!([aModel('m1')]);
    await scheduled.promises[0];
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['m1']);
  });

  test('within SOFT returns the stored catalog without scheduling a refresh', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 1000, models: [aModel('cached')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    const scheduled = captureScheduled();

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.map(model => model.id)).toEqual(['cached']);
    expect(scheduled.promises).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('every stale age remains SWR forever', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 365 * 24 * 60 * 60_000, models: [aModel('stale')] });
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const scheduled = captureScheduled();

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.map(model => model.id)).toEqual(['stale']);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    resolveFetch!([aModel('fresh')]);
    await scheduled.promises[0];
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['fresh']);
  });

  test('force is the explicit fetch operation and blocks for a fresh result', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    const scheduled = captureScheduled();

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher, force: true },
    );

    expect(result.map(model => model.id)).toEqual(['fresh']);
    expect(scheduled.promises).toEqual([]);
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['fresh']);
  });

  test('concurrent cold callers join one background refresh', async () => {
    await setupRepo();
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const instance = stubInstance(fetchFn);
    const scheduled = captureScheduled();

    const [first, second] = await Promise.all([
      fetchUpstreamModelsCached(instance, { scheduler: scheduled.scheduler, fetcher: directFetcher }),
      fetchUpstreamModelsCached(instance, { scheduler: scheduled.scheduler, fetcher: directFetcher }),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    resolveFetch!([aModel('m1')]);
    await Promise.all(scheduled.promises);
  });

  test('a failed refresh preserves stale data and activates persistent backoff', async () => {
    const repo = await setupRepo();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: now - 20 * 60_000, models: [aModel('stale')] });
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });
    const instance = stubInstance(fetchFn, cache);
    const firstScheduled = captureScheduled();

    expect((await fetchUpstreamModelsCached(instance, { scheduler: firstScheduled.scheduler, fetcher: directFetcher })).map(model => model.id)).toEqual(['stale']);
    await expect(firstScheduled.promises[0]).rejects.toThrow('boom');

    clearInFlightForTesting();
    const secondScheduled = captureScheduled();
    expect((await fetchUpstreamModelsCached(instance, { scheduler: secondScheduled.scheduler, fetcher: directFetcher })).map(model => model.id)).toEqual(['stale']);
    await expect(secondScheduled.promises[0]).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.lastError?.message).toContain('boom');
  });

  test('cold failures return empty and retry after the persisted backoff expires', async () => {
    const repo = await setupRepo();
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchFn = vi.fn(async () => { throw new Error('boom'); });
    const instance = stubInstance(fetchFn);

    const firstScheduled = captureScheduled();
    await expect(fetchUpstreamModelsCached(instance, { scheduler: firstScheduled.scheduler, fetcher: directFetcher })).resolves.toEqual([]);
    await expect(firstScheduled.promises[0]).rejects.toThrow('boom');
    expect(await storedCache(repo)).toMatchObject({ fetchedAt: 0, models: [], lastError: { message: 'boom' } });

    clearInFlightForTesting();
    now += 59_999;
    const backedOff = captureScheduled();
    await expect(fetchUpstreamModelsCached(instance, { scheduler: backedOff.scheduler, fetcher: directFetcher })).resolves.toEqual([]);
    await expect(backedOff.promises[0]).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clearInFlightForTesting();
    now += 1;
    const retry = captureScheduled();
    await expect(fetchUpstreamModelsCached(instance, { scheduler: retry.scheduler, fetcher: directFetcher })).resolves.toEqual([]);
    await expect(retry.promises[0]).rejects.toThrow('boom');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('synchronous warm respects backoff while explicit force bypasses it', async () => {
    const repo = await setupRepo();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const failing = stubInstance(async () => { throw new Error('boom'); }, null, CACHE_GENERATION, 'backoff-source');
    const scheduled = captureScheduled();
    await fetchUpstreamModelsCached(failing, { scheduler: scheduled.scheduler, fetcher: directFetcher });
    await expect(scheduled.promises[0]).rejects.toThrow('boom');
    clearInFlightForTesting();

    const fetchFn = vi.fn(async () => [aModel('recovered')]);
    const cache = await storedCache(repo);
    const warming = stubInstance(fetchFn, cache, CACHE_GENERATION, 'warm-during-backoff');
    await expect(warmUpstreamModels(warming, directFetcher)).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(fetchUpstreamModelsCached(warming, { scheduler: () => {}, fetcher: directFetcher, force: true }))
      .resolves.toEqual([aModel('recovered')]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('synchronous warm waits for a refresh owned by another runtime', async () => {
    const repo = await setupRepo();
    const now = Date.now();
    await expect(repo.upstreams.claimModelsRefresh({ id: UPSTREAM_ID, generation: CACHE_GENERATION, token: 'remote-owner', now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null }))
      .resolves.toEqual({ kind: 'claimed', failureCount: 0 });
    const localFetch = vi.fn(async () => [aModel('duplicate-local-model')]);
    const warming = warmUpstreamModels(stubInstance(localFetch), directFetcher);

    let settled = false;
    void warming.finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    await repo.upstreams.finalizeModelsRefreshSuccess(UPSTREAM_ID, CACHE_GENERATION, 'remote-owner', {
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: now + 1,
      models: [aModel('remote-model')],
    });

    expect((await warming).map(model => model.id)).toEqual(['remote-model']);
    expect(localFetch).not.toHaveBeenCalled();
  });

  test('explicit force bypasses a local warm waiting on another runtime', async () => {
    const repo = await setupRepo();
    const now = Date.now();
    await repo.upstreams.claimModelsRefresh({ id: UPSTREAM_ID, generation: CACHE_GENERATION, token: 'remote-owner', now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null });
    const fetchFn = vi.fn(async () => [aModel('forced-model')]);
    const instance = stubInstance(fetchFn, null, CACHE_GENERATION, 'shared-warm-force-key');
    const warming = warmUpstreamModels(instance, directFetcher);
    await new Promise(resolve => setTimeout(resolve, 20));

    const forced = fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher, force: true });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect((await forced).map(model => model.id)).toEqual(['forced-model']);
    expect((await warming).map(model => model.id)).toEqual(['forced-model']);
  });

  test('an atomic success-finalize failure does not install upstream failure backoff', async () => {
    const repo = await setupRepo();
    const finalizeFailure = vi.spyOn(repo.upstreams, 'finalizeModelsRefreshFailure');
    vi.spyOn(repo.upstreams, 'finalizeModelsRefreshSuccess').mockRejectedValueOnce(new Error('finalize failed'));
    const instance = stubInstance(async () => [aModel('published-model')]);

    await expect(fetchUpstreamModelsCached(instance, { scheduler: () => {}, fetcher: directFetcher, force: true }))
      .rejects.toThrow('finalize failed');
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(await storedCache(repo)).toBeNull();
  });

  test('a superseded generation neither joins nor overwrites the current catalog', async () => {
    const repo = await setupRepo();
    let resolveOld: ((models: ProviderModel[]) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveOld = resolve; }));
    const oldScheduled = captureScheduled();
    await fetchUpstreamModelsCached(
      stubInstance(oldFetch, null, CACHE_GENERATION, 'same-fetch'),
      { scheduler: oldScheduled.scheduler, fetcher: directFetcher },
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(1));

    const nextGeneration = { updatedAt: CACHE_GENERATION.updatedAt, config: { identity: 'new' } };
    const current = await repo.upstreams.getById(UPSTREAM_ID);
    if (!current) throw new Error('upstream row missing');
    await repo.upstreams.saveClearingModelsCache({ ...current, updatedAt: nextGeneration.updatedAt, config: nextGeneration.config });
    const newFetch = vi.fn(async () => [aModel('new-tenant-model')]);
    const newResult = await fetchUpstreamModelsCached(
      stubInstance(newFetch, null, nextGeneration, 'same-fetch'),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );

    expect(newResult.map(model => model.id)).toEqual(['new-tenant-model']);
    resolveOld!([aModel('old-tenant-model')]);
    await oldScheduled.promises[0];
    expect(oldFetch).toHaveBeenCalledTimes(1);
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['new-tenant-model']);
  });

  test('a forced fetch prevents an older claim from publishing a late success', async () => {
    const repo = await setupRepo();
    let resolveOld: ((models: ProviderModel[]) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveOld = resolve; }));
    const oldScheduled = captureScheduled();
    await fetchUpstreamModelsCached(
      stubInstance(oldFetch, null, CACHE_GENERATION, 'old-claim'),
      { scheduler: oldScheduled.scheduler, fetcher: directFetcher },
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(1));

    const forced = await fetchUpstreamModelsCached(
      stubInstance(async () => [aModel('forced-model')], null, CACHE_GENERATION, 'forced-claim'),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );
    expect(forced.map(model => model.id)).toEqual(['forced-model']);

    resolveOld!([aModel('late-old-model')]);
    await oldScheduled.promises[0];
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['forced-model']);
  });

  test('a forced fetch prevents an older claim from publishing a late error', async () => {
    const repo = await setupRepo();
    let rejectOld: ((error: Error) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>((_resolve, reject) => { rejectOld = reject; }));
    const oldScheduled = captureScheduled();
    await fetchUpstreamModelsCached(
      stubInstance(oldFetch, null, CACHE_GENERATION, 'old-error-claim'),
      { scheduler: oldScheduled.scheduler, fetcher: directFetcher },
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(1));

    await fetchUpstreamModelsCached(
      stubInstance(async () => [aModel('forced-model')], null, CACHE_GENERATION, 'forced-error-claim'),
      { scheduler: () => {}, fetcher: directFetcher, force: true },
    );
    rejectOld!(new Error('late old failure'));
    await expect(oldScheduled.promises[0]).rejects.toThrow('late old failure');

    expect(await storedCache(repo)).toMatchObject({
      models: [{ id: 'forced-model' }],
      lastError: null,
    });

    clearInFlightForTesting();
    const recovery = vi.fn(async () => [aModel('post-race-model')]);
    await warmUpstreamModels(stubInstance(recovery, await storedCache(repo), CACHE_GENERATION, 'post-race'), directFetcher);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  test('catalog revision mismatch is cold and refreshes without blocking', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, {
      revision: MODEL_CATALOG_REVISION - 1,
      fetchedAt: Date.now() - 1000,
      models: [aModel('old-catalog')],
    });
    const fetchFn = vi.fn(async () => [aModel('current-catalog')]);
    const scheduled = captureScheduled();

    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result).toEqual([]);
    await scheduled.promises[0];
    expect((await storedCache(repo))?.revision).toBe(MODEL_CATALOG_REVISION);
  });

  test('an obsolete SQL cache hydrates cold and is replaced in the background', async () => {
    const db = await createSqliteTestDb();
    const repo = new SqlRepo(db);
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
    await db.prepare('UPDATE upstreams SET models_cache_json = ? WHERE id = ?').bind(JSON.stringify({
      revision: MODEL_CATALOG_REVISION - 1,
      fetchedAt: Date.now() - 1_000,
      models: [{ id: 'old-catalog', enabledFlags: [] }],
      lastError: null,
    }), UPSTREAM_ID).run();

    const hydrated = await repo.upstreams.getById(UPSTREAM_ID);
    if (!hydrated) throw new Error('upstream row missing');
    expect(hydrated.modelsCache).toBeNull();
    const fetchFn = vi.fn(async () => [aModel('current-catalog')]);
    const scheduled = captureScheduled();
    const result = await fetchUpstreamModelsCached(
      stubInstance(fetchFn, hydrated.modelsCache, { updatedAt: hydrated.updatedAt, config: hydrated.config }),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result).toEqual([]);
    await scheduled.promises[0];
    expect((await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache?.revision).toBe(MODEL_CATALOG_REVISION);
  });
});
