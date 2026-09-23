import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { modelsRefreshIdentity } from './models-cache-fixture.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { MAX_STORED_MODEL_ERROR_LENGTH, MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { modelsRefreshRetryAt } from '../../src/repo/models-refresh-backoff.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo, StoredUpstreamRecord } from '../../src/repo/types.ts';

const record: StoredUpstreamRecord = {
  id: 'up_refresh',
  kind: 'custom',
  name: 'Refresh',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { tenant: 'current' },
  state: null,
  configVersion: 1,
  modelsCache: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
};

const factories: [string, () => Promise<Repo>][] = [
  ['memory', async () => new InMemoryRepo()],
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(factories)('%s models refresh persistence', (_name, createRepo) => {
  test('bounds a stored failure without changing the caller input', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const message = 'x'.repeat(MAX_STORED_MODEL_ERROR_LENGTH + 100);

    await repo.recordModelsRefreshFailure({
      id: record.id,
      ...modelsRefreshIdentity(record),
      error: { message, at: 100 },
      previousFailureCount: 0,
    });

    const stored = (await repo.getById(record.id))?.modelsCache?.lastError?.message;
    expect(stored).toHaveLength(MAX_STORED_MODEL_ERROR_LENGTH);
    expect(stored?.endsWith('…')).toBe(true);
    expect(message).toHaveLength(MAX_STORED_MODEL_ERROR_LENGTH + 100);
  });

  test('derives exponential retry times from the persisted failure count', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const identity = modelsRefreshIdentity(record);
    let now = 1_800_000_000_000;

    for (const [failureCount, minutes] of [1, 5, 30, 120, 120].entries()) {
      await expect(repo.recordModelsRefreshFailure({
        id: record.id,
        ...identity,
        error: { message: 'failure', at: now },
        previousFailureCount: failureCount,
      })).resolves.toBe(true);
      const stored = await repo.getById(record.id);
      expect(stored?.modelsCache?.lastError).toEqual({ message: 'failure', at: now, failureCount: failureCount + 1 });
      const retryAt = modelsRefreshRetryAt(stored!.modelsCache!.lastError!);
      expect(retryAt - now).toBe(minutes * 60_000);
      now = retryAt;
    }
  });

  test('success publishes the catalog and clears failure backoff', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const identity = modelsRefreshIdentity(record);
    const now = 1_800_000_000_000;
    await repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'failure', at: now }, previousFailureCount: 0 });

    await expect(repo.publishModelsRefresh({
      id: record.id,
      ...identity,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, models: [] },
    })).resolves.toBe(true);
    const refreshed = await repo.getById(record.id);
    if (refreshed === null) throw new Error('refreshed upstream missing');
    expect(refreshed.modelsCache).toMatchObject({ fetchedAt: now + 1, lastError: null });
  });

  test('config changes fence stale success and failure publication', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const identity = modelsRefreshIdentity(record);
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await repo.replaceForModels({ previous: current, upstream: { ...current, config: { tenant: 'next' } } });

    await expect(repo.publishModelsRefresh({ id: record.id, ...identity, cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 1, models: [] } }))
      .resolves.toBe(false);
    await expect(repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'old', at: 1 }, previousFailureCount: 0 }))
      .resolves.toBe(false);
  });

  test('deleting and reinserting the same ID cannot accept old refresh results', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const oldIdentity = modelsRefreshIdentity(record);
    await repo.delete(record.id);
    await saveUpstreamForTest(repo, { ...record, config: { tenant: 'replacement' } });

    await expect(repo.publishModelsRefresh({ id: record.id, ...oldIdentity, cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 1, models: [] } }))
      .resolves.toBe(false);
    await expect(repo.recordModelsRefreshFailure({ id: record.id, ...oldIdentity, error: { message: 'old', at: 1 }, previousFailureCount: 0 }))
      .resolves.toBe(false);
    expect((await repo.getById(record.id))?.modelsCache).toBeNull();
  });

  test('cache publication fences stale completions from the same config', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const cold = modelsRefreshIdentity(record);
    await expect(repo.publishModelsRefresh({
      id: record.id,
      ...cold,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 10, models: [] },
    })).resolves.toBe(true);
    await expect(repo.recordModelsRefreshFailure({
      id: record.id,
      ...cold,
      error: { message: 'stale failure', at: 11 },
      previousFailureCount: 0,
    })).resolves.toBe(false);

    const fresh = await repo.getById(record.id);
    if (fresh === null) throw new Error('fresh upstream missing');
    expect(fresh.modelsCache?.lastError).toBeNull();
    await repo.recordModelsRefreshFailure({
      id: record.id,
      ...modelsRefreshIdentity(fresh),
      error: { message: 'current failure', at: 12 },
      previousFailureCount: 0,
    });
    await expect(repo.publishModelsRefresh({
      id: record.id,
      ...cold,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 13, models: [] },
    })).resolves.toBe(false);
    expect((await repo.getById(record.id))?.modelsCache).toMatchObject({ fetchedAt: 10, lastError: { message: 'current failure' } });
  });

  test('one failure per cache epoch and prior failure count wins the CAS', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const identity = modelsRefreshIdentity(record);
    await expect(repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'first', at: 100 }, previousFailureCount: 0 }))
      .resolves.toBe(true);
    await expect(repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'late', at: 101 }, previousFailureCount: 0 }))
      .resolves.toBe(false);
    expect((await repo.getById(record.id))?.modelsCache?.lastError).toEqual({ message: 'first', at: 100, failureCount: 1 });
  });

  test('transport edits retain models but clear backoff, while metadata edits preserve it', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    await repo.publishModelsRefresh({ id: record.id, ...modelsRefreshIdentity(record), cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 10, models: [] } });
    await repo.recordModelsRefreshFailure({ id: record.id, ...modelsRefreshIdentity(record), cacheEpoch: 10, error: { message: 'failure', at: 20 }, previousFailureCount: 0 });
    const failed = await repo.getById(record.id);
    if (failed === null) throw new Error('failed upstream missing');
    await repo.replaceForModels({ previous: failed, upstream: { ...failed, name: 'Metadata' } });
    const renamed = await repo.getById(record.id);
    expect(renamed?.modelsCache?.lastError?.failureCount).toBe(1);
    if (renamed === null) throw new Error('renamed upstream missing');
    await repo.replaceForModels({ previous: renamed, upstream: { ...renamed, proxyFallbackList: [{ id: 'direct_fetch' }] } });
    const transported = await repo.getById(record.id);
    expect(transported?.configVersion).toBe(2);
    expect(transported?.modelsCache).toMatchObject({ fetchedAt: 10, models: [], lastError: null });
  });

  test('state and metadata changes preserve the config version and backoff', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const identity = modelsRefreshIdentity(record);
    const now = 1_800_000_000_000;
    await repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'failure', at: now }, previousFailureCount: 0 });
    await repo.saveState(record.id, () => ({ credential: 'rotated' }));
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await repo.replaceForModels({ previous: current, upstream: { ...current, name: 'Renamed' } });

    expect((await repo.getById(record.id))?.configVersion).toBe(1);
    expect((await repo.getById(record.id))?.modelsCache?.lastError?.failureCount).toBe(1);
  });

  test('catalog-aware writes reject stale and duplicate control-plane writers', async () => {
    const repo = (await createRepo()).upstreams;
    await expect(repo.insertForModels(record)).resolves.not.toBeNull();
    await expect(repo.insertForModels({ ...record, name: 'Loser' })).resolves.toBeNull();
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await expect(repo.replaceForModels({ previous: current, upstream: { ...current, name: 'Winner' } })).resolves.not.toBeNull();
    await expect(repo.replaceForModels({ previous: current, upstream: { ...current, name: 'Stale' } })).resolves.toBeNull();
  });
});
