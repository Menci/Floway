import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { modelsRefreshRetryAt } from '../../src/repo/models-refresh-backoff.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { stubUpstreamModel } from '@floway-dev/test-utils';
import type { UpstreamRecord } from '@floway-dev/upstream';

const record: UpstreamRecord = {
  id: 'up_refresh',
  kind: 'custom',
  name: 'Refresh',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { tenant: 'current' },
  state: null,
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
  test('derives exponential retry times from the persisted failure count and filters due list', async () => {
    const repo = (await createRepo()).upstreams;
    await saveUpstreamForTest(repo, record);
    const initial = (await repo.getById(record.id))!;
    let now = 1_800_000_000_000;

    for (const [failureCount, minutes] of [1, 5, 30, 120, 120].entries()) {
      await expect(repo.recordModelsRefreshFailure({
        id: record.id,
        version: initial.version,
        error: { message: 'failure', at: now },
      })).resolves.toBe(true);
      const stored = await repo.getById(record.id);
      expect(stored?.modelsCache.lastError).toEqual({ message: 'failure', at: now, failureCount: failureCount + 1 });
      const retryAt = modelsRefreshRetryAt(stored!.modelsCache.lastError!);
      expect(retryAt - now).toBe(minutes * 60_000);
      expect(await repo.listDueModelsRefresh(MODEL_CATALOG_REVISION, retryAt - 1)).toEqual([]);
      expect((await repo.listDueModelsRefresh(MODEL_CATALOG_REVISION, retryAt)).map(c => c.id)).toEqual([record.id]);
      now = retryAt;
    }
  });

  test('success publishes the catalog and clears failure backoff', async () => {
    const fullRepo = await createRepo();
    const repo = fullRepo.upstreams;
    await saveUpstreamForTest(repo, record);
    const initial = (await repo.getById(record.id))!;
    const now = 1_800_000_000_000;
    await repo.recordModelsRefreshFailure({ id: record.id, version: initial.version, error: { message: 'failure', at: now } });

    const publishedVersion = await repo.publishModelsRefresh({
      id: record.id,
      version: initial.version,
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: now + 1,
      models: [{ source: 'auto', model: stubUpstreamModel({ id: 'm1' }) }],
    });
    expect(publishedVersion).not.toBeNull();
    const refreshed = await repo.getById(record.id);
    if (refreshed === null) throw new Error('refreshed upstream missing');
    expect(refreshed.version).toBe(publishedVersion);
    expect(refreshed.modelsCache).toEqual({ revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, lastError: null });
    expect((await fullRepo.upstreamModels.listByUpstream(record.id)).map(entry => entry.model.id)).toEqual(['m1']);
  });

  test('config changes fence stale success and failure publication', async () => {
    const fullRepo = await createRepo();
    const repo = fullRepo.upstreams;
    await saveUpstreamForTest(repo, record);
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await repo.replace({
      previous: current,
      upstream: { ...current, config: { tenant: 'next' } },
    });

    await expect(repo.publishModelsRefresh({
      id: record.id,
      version: current.version,
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: 1,
      models: [{ source: 'auto', model: stubUpstreamModel({ id: 'stale' }) }],
    })).resolves.toBeNull();
    await expect(repo.recordModelsRefreshFailure({ id: record.id, version: current.version, error: { message: 'old', at: 1 } }))
      .resolves.toBe(false);
    expect(await fullRepo.upstreamModels.listByUpstream(record.id)).toEqual([]);
  });

  test('transport edits retain models and clear backoff, while metadata edits preserve backoff', async () => {
    const fullRepo = await createRepo();
    const repo = fullRepo.upstreams;
    await saveUpstreamForTest(repo, record);
    const initial = (await repo.getById(record.id))!;
    const publishedVersion = await repo.publishModelsRefresh({
      id: record.id,
      version: initial.version,
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: 10,
      models: [{ source: 'auto', model: stubUpstreamModel({ id: 'kept' }) }],
    });
    if (publishedVersion === null) throw new Error('publish failed');
    await repo.recordModelsRefreshFailure({ id: record.id, version: publishedVersion, error: { message: 'failure', at: 20 } });
    const failed = await repo.getById(record.id);
    if (failed === null) throw new Error('failed upstream missing');
    await repo.replace({ previous: failed, upstream: { ...failed, name: 'Metadata' } });
    const renamed = await repo.getById(record.id);
    expect(renamed?.modelsCache.lastError?.failureCount).toBe(1);
    if (renamed === null) throw new Error('renamed upstream missing');
    await repo.replace({
      previous: renamed,
      upstream: { ...renamed, proxyFallbackList: [{ id: 'direct_fetch' }] },
      modelsWrite: { cacheAction: { kind: 'mark-stale' } },
    });
    const transported = await repo.getById(record.id);
    expect(transported?.version).not.toBe(renamed.version);
    expect(transported?.modelsCache).toEqual({ revision: null, fetchedAt: 10, lastError: null });
    expect((await fullRepo.upstreamModels.listByUpstream(record.id)).map(entry => entry.model.id)).toEqual(['kept']);
  });

  test('optimistic writes reject stale and duplicate control-plane writers without corrupting child rows', async () => {
    const fullRepo = await createRepo();
    const repo = fullRepo.upstreams;
    await expect(repo.insert({ upstream: record })).resolves.not.toBeNull();
    await expect(repo.insert({
      upstream: { ...record, name: 'Loser' },
      manualModels: [{ upstreamModelId: 'loser', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    })).resolves.toBeNull();
    expect(await fullRepo.upstreamModels.listManualModels(record.id)).toEqual([]);
    const current = await repo.getById(record.id);
    if (current === null) throw new Error('upstream row missing');
    await expect(repo.replace({
      previous: current,
      upstream: { ...current, name: 'Winner' },
      manualModels: [{ upstreamModelId: 'winner', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    })).resolves.not.toBeNull();
    await expect(repo.replace({
      previous: current,
      upstream: { ...current, name: 'Stale' },
      manualModels: [{ upstreamModelId: 'stale', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
    })).resolves.toBeNull();
    expect((await fullRepo.upstreamModels.listManualModels(record.id)).map(m => m.upstreamModelId)).toEqual(['winner']);
  });
});
