import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { modelsRefreshIdentity } from './models-cache-fixture.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
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
  test('applies retry backoff and lets an explicit refresh bypass it', async () => {
    const repo = (await createRepo()).upstreams;
    await repo.save(record);
    const identity = modelsRefreshIdentity(record);
    let now = 1_800_000_000_000;

    for (const [failureCount, minutes] of [1, 5, 30, 120, 120].entries()) {
      await expect(repo.beginModelsRefresh({ id: record.id, ...identity, now, bypassBackoff: false }))
        .resolves.toEqual({ kind: 'ready', failureCount });
      await expect(repo.recordModelsRefreshFailure({
        id: record.id,
        ...identity,
        error: { message: 'failure', at: now },
        previousFailureCount: failureCount,
        failedAt: now,
      })).resolves.toBe(true);
      const retryAt = modelsRefreshRetryAt(now, failureCount);
      expect(retryAt - now).toBe(minutes * 60_000);
      await expect(repo.beginModelsRefresh({ id: record.id, ...identity, now: retryAt - 1, bypassBackoff: false }))
        .resolves.toEqual({ kind: 'backoff' });
      await expect(repo.beginModelsRefresh({ id: record.id, ...identity, now: retryAt - 1, bypassBackoff: true }))
        .resolves.toEqual({ kind: 'ready', failureCount: failureCount + 1 });
      now = retryAt;
    }
  });

  test('success publishes the catalog and clears failure backoff', async () => {
    const repo = (await createRepo()).upstreams;
    await repo.save(record);
    const identity = modelsRefreshIdentity(record);
    const now = 1_800_000_000_000;
    await repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'failure', at: now }, previousFailureCount: 0, failedAt: now });

    await expect(repo.publishModelsRefresh({
      id: record.id,
      ...identity,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, models: [] },
    })).resolves.toBe(true);
    const refreshed = await repo.getById(record.id);
    if (refreshed === null) throw new Error('refreshed upstream missing');
    await expect(repo.beginModelsRefresh({ id: record.id, ...modelsRefreshIdentity(refreshed), now: now + 2, bypassBackoff: false }))
      .resolves.toEqual({ kind: 'ready', failureCount: 0 });
    expect((await repo.getById(record.id))?.modelsCache).toMatchObject({ fetchedAt: now + 1, lastError: null });
  });

  test('config changes fence stale success and failure publication', async () => {
    const repo = (await createRepo()).upstreams;
    await repo.save(record);
    const identity = modelsRefreshIdentity(record);
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await repo.replaceForModels({ previous: current, upstream: { ...current, config: { tenant: 'next' } } });

    await expect(repo.beginModelsRefresh({ id: record.id, ...identity, now: 1, bypassBackoff: true }))
      .resolves.toEqual({ kind: 'superseded' });
    await expect(repo.publishModelsRefresh({ id: record.id, ...identity, cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 1, models: [] } }))
      .resolves.toBe(false);
    await expect(repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'old', at: 1 }, previousFailureCount: 0, failedAt: 1 }))
      .resolves.toBe(false);
  });

  test('cache publication fences stale completions from the same config', async () => {
    const repo = (await createRepo()).upstreams;
    await repo.save(record);
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
      failedAt: 11,
    })).resolves.toBe(false);

    const fresh = await repo.getById(record.id);
    if (fresh === null) throw new Error('fresh upstream missing');
    expect(fresh.modelsCache?.lastError).toBeNull();
    await repo.recordModelsRefreshFailure({
      id: record.id,
      ...modelsRefreshIdentity(fresh),
      error: { message: 'current failure', at: 12 },
      previousFailureCount: 0,
      failedAt: 12,
    });
    await expect(repo.publishModelsRefresh({
      id: record.id,
      ...cold,
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 13, models: [] },
    })).resolves.toBe(false);
    expect((await repo.getById(record.id))?.modelsCache).toMatchObject({ fetchedAt: 10, lastError: { message: 'current failure' } });
  });

  test('state and metadata changes preserve the config version and backoff', async () => {
    const repo = (await createRepo()).upstreams;
    await repo.save(record);
    const identity = modelsRefreshIdentity(record);
    const now = 1_800_000_000_000;
    await repo.recordModelsRefreshFailure({ id: record.id, ...identity, error: { message: 'failure', at: now }, previousFailureCount: 0, failedAt: now });
    await repo.saveState(record.id, () => ({ credential: 'rotated' }));
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await repo.replaceForModels({ previous: current, upstream: { ...current, name: 'Renamed' } });

    expect((await repo.getById(record.id))?.configVersion).toBe(1);
    await expect(repo.beginModelsRefresh({ id: record.id, ...modelsRefreshIdentity(current), now: now + 1, bypassBackoff: false }))
      .resolves.toEqual({ kind: 'backoff' });
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
