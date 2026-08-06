import { beforeEach, describe, expect, test, vi } from 'vitest';

import { readUpstreamModelsSnapshotAndScheduleRefresh, MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { clearModelsRefreshesForTesting, fetchUpstreamModels, warmUpstreamModels } from '../../../src/data-plane/providers/models-refresh.ts';
import type { GatewayProvider } from '../../../src/data-plane/providers/registry.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { modelsCacheGeneration } from '../../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../../src/repo/sql.ts';
import type { ModelsCacheGeneration } from '../../../src/repo/types.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import { directFetcher, type ProviderModel, type UpstreamModelsCache } from '@floway-dev/provider';
import { stubProvider, stubProviderModel } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_a';
const CACHE_CONFIG = { identity: 'old' };
const CACHE_GENERATION: ModelsCacheGeneration = {
  configVersion: 1,
};

const aModel = (id: string): ProviderModel => stubProviderModel({ id });

const stubInstance = (
  fetchFn: () => Promise<ProviderModel[]>,
  modelsCache: UpstreamModelsCache | null = null,
  generation: ModelsCacheGeneration = CACHE_GENERATION,
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
    updatedAt: '2026-08-01T00:00:00.000Z',
    config: CACHE_CONFIG,
    state: null,
    configVersion: 1,
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
  clearModelsRefreshesForTesting();
});

describe('readUpstreamModelsSnapshotAndScheduleRefresh', () => {
  test('cold cache returns immediately and refreshes in the background', async () => {
    const repo = await setupRepo();
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const scheduled = captureScheduled();

    const result = readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(fetchFn),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.models).toEqual([]);
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

    const result = readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.models.map(model => model.id)).toEqual(['cached']);
    expect(scheduled.promises).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('snapshots remain usable regardless of age while refresh runs separately', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 365 * 24 * 60 * 60_000, models: [aModel('stale')] });
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const scheduled = captureScheduled();

    const result = readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.models.map(model => model.id)).toEqual(['stale']);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    resolveFetch!([aModel('fresh')]);
    await scheduled.promises[0];
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['fresh']);
  });

  test('explicit fetch blocks for a fresh result', async () => {
    const repo = await setupRepo();
    const cache = await seedCache(repo, { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now() - 1000, models: [aModel('stored')] });
    const fetchFn = vi.fn(async () => [aModel('fresh')]);
    const result = await fetchUpstreamModels(stubInstance(fetchFn, cache), directFetcher);

    expect(result.map(model => model.id)).toEqual(['fresh']);
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['fresh']);
  });

  test('concurrent cold callers join one background refresh', async () => {
    await setupRepo();
    let resolveFetch: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveFetch = resolve; }));
    const instance = stubInstance(fetchFn);
    const scheduled = captureScheduled();

    const [first, second] = [
      readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: scheduled.scheduler, fetcher: directFetcher }),
      readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: scheduled.scheduler, fetcher: directFetcher }),
    ];

    expect(first.models).toEqual([]);
    expect(second.models).toEqual([]);
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

    expect(readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: firstScheduled.scheduler, fetcher: directFetcher }).models.map(model => model.id)).toEqual(['stale']);
    await expect(firstScheduled.promises[0]).rejects.toThrow('boom');

    clearModelsRefreshesForTesting();
    const secondScheduled = captureScheduled();
    expect(readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: secondScheduled.scheduler, fetcher: directFetcher }).models.map(model => model.id)).toEqual(['stale']);
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
    expect(readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: firstScheduled.scheduler, fetcher: directFetcher }).models).toEqual([]);
    await expect(firstScheduled.promises[0]).rejects.toThrow('boom');
    expect(await storedCache(repo)).toMatchObject({ fetchedAt: 0, models: [], lastError: { message: 'boom' } });

    clearModelsRefreshesForTesting();
    now += 59_999;
    const backedOff = captureScheduled();
    expect(readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: backedOff.scheduler, fetcher: directFetcher }).models).toEqual([]);
    await expect(backedOff.promises[0]).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clearModelsRefreshesForTesting();
    now += 1;
    const retry = captureScheduled();
    expect(readUpstreamModelsSnapshotAndScheduleRefresh(instance, { scheduler: retry.scheduler, fetcher: directFetcher }).models).toEqual([]);
    await expect(retry.promises[0]).rejects.toThrow('boom');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('synchronous warm respects backoff while explicit fetch bypasses it', async () => {
    const repo = await setupRepo();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const failing = stubInstance(async () => { throw new Error('boom'); });
    const scheduled = captureScheduled();
    readUpstreamModelsSnapshotAndScheduleRefresh(failing, { scheduler: scheduled.scheduler, fetcher: directFetcher });
    await expect(scheduled.promises[0]).rejects.toThrow('boom');
    clearModelsRefreshesForTesting();

    const fetchFn = vi.fn(async () => [aModel('recovered')]);
    const cache = await storedCache(repo);
    const warming = stubInstance(fetchFn, cache);
    await expect(warmUpstreamModels(warming, directFetcher)).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(fetchUpstreamModels(warming, directFetcher))
      .resolves.toEqual([aModel('recovered')]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('synchronous warm waits for a refresh owned by another runtime', async () => {
    const repo = await setupRepo();
    const now = Date.now();
    await expect(repo.upstreams.claimModelsRefresh({ id: UPSTREAM_ID, generation: CACHE_GENERATION, token: 'remote-owner', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null }))
      .resolves.toEqual({ kind: 'claimed', failureCount: 0 });
    const localFetch = vi.fn(async () => [aModel('duplicate-local-model')]);
    const warming = warmUpstreamModels(stubInstance(localFetch), directFetcher);

    let settled = false;
    void warming.finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    await repo.upstreams.finalizeModelsRefreshSuccess({
      id: UPSTREAM_ID,
      generation: CACHE_GENERATION,
      token: 'remote-owner',
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, models: [aModel('remote-model')] },
    });

    expect((await warming).map(model => model.id)).toEqual(['remote-model']);
    expect(localFetch).not.toHaveBeenCalled();
  });

  test('explicit fetch follows the durable owner already awaited by a local warm', async () => {
    const repo = await setupRepo();
    const now = Date.now();
    await repo.upstreams.claimModelsRefresh({ id: UPSTREAM_ID, generation: CACHE_GENERATION, token: 'remote-owner', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null });
    const fetchFn = vi.fn(async () => [aModel('duplicate-local-model')]);
    const instance = stubInstance(fetchFn);
    const warming = warmUpstreamModels(instance, directFetcher);
    await new Promise(resolve => setTimeout(resolve, 20));

    const explicit = fetchUpstreamModels(instance, directFetcher);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchFn).not.toHaveBeenCalled();
    await repo.upstreams.finalizeModelsRefreshSuccess({
      id: UPSTREAM_ID,
      generation: CACHE_GENERATION,
      token: 'remote-owner',
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, models: [aModel('remote-model')] },
    });
    expect((await explicit).map(model => model.id)).toEqual(['remote-model']);
    expect((await warming).map(model => model.id)).toEqual(['remote-model']);
  });

  test('explicit fetch retries after a remote owner records failure', async () => {
    const repo = await setupRepo();
    const now = Date.now();
    await repo.upstreams.claimModelsRefresh({ id: UPSTREAM_ID, generation: CACHE_GENERATION, token: 'remote-owner', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null });
    const fetchFn = vi.fn(async () => [aModel('explicit-recovery-model')]);
    const explicit = fetchUpstreamModels(stubInstance(fetchFn), directFetcher);
    await new Promise(resolve => setTimeout(resolve, 20));

    await repo.upstreams.finalizeModelsRefreshFailure({
      id: UPSTREAM_ID,
      generation: CACHE_GENERATION,
      token: 'remote-owner',
      error: { message: 'remote failure', at: now + 1 },
      previousFailureCount: 0,
      failedAt: now + 1,
    });

    await expect(explicit).resolves.toEqual([aModel('explicit-recovery-model')]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  test('explicit fetch joins a warm that already owns the durable refresh', async () => {
    await setupRepo();
    let resolveWarm: ((models: ProviderModel[]) => void) | null = null;
    const fetchFn = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveWarm = resolve; }));
    const instance = stubInstance(fetchFn);
    const warming = warmUpstreamModels(instance, directFetcher);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const explicit = fetchUpstreamModels(instance, directFetcher);
    resolveWarm!([aModel('warm-owner-model')]);
    expect((await explicit).map(model => model.id)).toEqual(['warm-owner-model']);
    expect((await warming).map(model => model.id)).toEqual(['warm-owner-model']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('a transient success-finalize error is retried without installing failure backoff', async () => {
    const repo = await setupRepo();
    const finalizeFailure = vi.spyOn(repo.upstreams, 'finalizeModelsRefreshFailure');
    const finalizeSuccess = vi.spyOn(repo.upstreams, 'finalizeModelsRefreshSuccess').mockRejectedValueOnce(new Error('finalize failed'));
    const instance = stubInstance(async () => [aModel('published-model')]);

    await expect(fetchUpstreamModels(instance, directFetcher)).resolves.toEqual([aModel('published-model')]);
    expect(finalizeSuccess).toHaveBeenCalledTimes(2);
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect((await storedCache(repo))?.models).toEqual([aModel('published-model')]);
  });

  test('persistent finalize errors release the claim for a later refresh', async () => {
    const repo = await setupRepo();
    vi.spyOn(repo.upstreams, 'finalizeModelsRefreshSuccess').mockRejectedValue(new Error('storage unavailable'));

    await expect(fetchUpstreamModels(stubInstance(async () => [aModel('unpublished')]), directFetcher))
      .rejects.toThrow('Failed to finalize models refresh');
    await expect(repo.upstreams.claimModelsRefresh({
      id: UPSTREAM_ID,
      generation: CACHE_GENERATION,
      token: 'next-owner',
      now: Date.now(),
      staleClaimedBefore: Number.MIN_SAFE_INTEGER,
      bypassBackoff: false,
      observedActiveToken: null,
    })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
  });

  test('a superseded generation neither joins nor overwrites the current catalog', async () => {
    const repo = await setupRepo();
    let resolveOld: ((models: ProviderModel[]) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveOld = resolve; }));
    const oldScheduled = captureScheduled();
    readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(oldFetch),
      { scheduler: oldScheduled.scheduler, fetcher: directFetcher },
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(1));

    const nextConfig = { identity: 'new' };
    const nextGeneration = { configVersion: CACHE_GENERATION.configVersion + 1 };
    const current = await repo.upstreams.getById(UPSTREAM_ID);
    if (!current) throw new Error('upstream row missing');
    await repo.upstreams.replaceForModels({ previous: current, upstream: { ...current, config: nextConfig } });
    const newFetch = vi.fn(async () => [aModel('new-tenant-model')]);
    const newResult = await fetchUpstreamModels(stubInstance(newFetch, null, nextGeneration), directFetcher);

    expect(newResult.map(model => model.id)).toEqual(['new-tenant-model']);
    resolveOld!([aModel('old-tenant-model')]);
    await oldScheduled.promises[0];
    expect(oldFetch).toHaveBeenCalledTimes(1);
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['new-tenant-model']);
  });

  test('explicit fetch joins an older background refresh instead of preempting it', async () => {
    const repo = await setupRepo();
    let resolveOld: ((models: ProviderModel[]) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>(resolve => { resolveOld = resolve; }));
    const oldScheduled = captureScheduled();
    readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(oldFetch),
      { scheduler: oldScheduled.scheduler, fetcher: directFetcher },
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(1));

    const explicitFetch = vi.fn(async () => [aModel('duplicate-explicit-model')]);
    const explicit = fetchUpstreamModels(stubInstance(explicitFetch), directFetcher);
    resolveOld!([aModel('late-old-model')]);
    expect((await explicit).map(model => model.id)).toEqual(['late-old-model']);
    await oldScheduled.promises[0];
    expect(explicitFetch).not.toHaveBeenCalled();
    expect((await storedCache(repo))?.models.map(model => model.id)).toEqual(['late-old-model']);
  });

  test('explicit fetch retries with its own transport after an older background owner fails', async () => {
    const repo = await setupRepo();
    let rejectOld: ((error: Error) => void) | null = null;
    const oldFetch = vi.fn(() => new Promise<ProviderModel[]>((_resolve, reject) => { rejectOld = reject; }));
    const oldScheduled = captureScheduled();
    readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(oldFetch),
      { scheduler: oldScheduled.scheduler, fetcher: directFetcher },
    );
    await vi.waitFor(() => expect(oldFetch).toHaveBeenCalledTimes(1));

    const explicitFetch = vi.fn(async () => [aModel('explicit-recovery-model')]);
    const explicitInstance = stubInstance(explicitFetch);
    const firstExplicit = fetchUpstreamModels(explicitInstance, directFetcher);
    const secondExplicit = fetchUpstreamModels(explicitInstance, directFetcher);
    rejectOld!(new Error('late old failure'));
    await expect(oldScheduled.promises[0]).rejects.toThrow('late old failure');
    await expect(firstExplicit).resolves.toEqual([aModel('explicit-recovery-model')]);
    await expect(secondExplicit).resolves.toEqual([aModel('explicit-recovery-model')]);
    expect(explicitFetch).toHaveBeenCalledOnce();
    expect(await storedCache(repo)).toMatchObject({ models: [{ id: 'explicit-recovery-model' }], lastError: null });
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

    const result = readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(fetchFn, cache),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.models).toEqual([]);
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
      configVersion: 1,
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
    const result = readUpstreamModelsSnapshotAndScheduleRefresh(
      stubInstance(fetchFn, hydrated.modelsCache, modelsCacheGeneration(hydrated)),
      { scheduler: scheduled.scheduler, fetcher: directFetcher },
    );

    expect(result.models).toEqual([]);
    await scheduled.promises[0];
    expect((await repo.upstreams.getById(UPSTREAM_ID))?.modelsCache?.revision).toBe(MODEL_CATALOG_REVISION);
  });
});
