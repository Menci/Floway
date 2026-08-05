import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ModelsCacheGeneration, Repo } from '../../src/repo/types.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const record: UpstreamRecord = {
  id: 'up_refresh',
  kind: 'custom',
  name: 'Refresh',
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
};

const generation: ModelsCacheGeneration = { updatedAt: record.updatedAt, config: record.config };

const factories: [string, () => Promise<Repo>][] = [
  ['memory', async () => new InMemoryRepo()],
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(factories)('%s models refresh coordination', (_name, createRepo) => {
  test('claims atomically, backs failures off exponentially, and lets force bypass cooldown', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;

    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'first', now, now - 900_000, false)).resolves.toBe(true);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'racer', now, now - 900_000, false)).resolves.toBe(false);
    await repo.upstreams.completeModelsRefreshFailure(record.id, 'first', now);

    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'early', now + 59_999, now - 900_000, false)).resolves.toBe(false);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'second', now + 60_000, now - 840_000, false)).resolves.toBe(true);
    await repo.upstreams.completeModelsRefreshFailure(record.id, 'second', now + 60_000);

    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'second-early', now + 179_999, now - 720_000, false)).resolves.toBe(false);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'forced', now + 60_001, now - 839_999, true)).resolves.toBe(true);
    await repo.upstreams.completeModelsRefreshSuccess(record.id, 'forced');
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'after-success', now + 60_002, now - 839_998, false)).resolves.toBe(true);
  });

  test('recovers abandoned claims and fences stale generations and completions', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;

    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'abandoned', now, now - 900_000, false)).resolves.toBe(true);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'replacement', now + 900_001, now + 1, false)).resolves.toBe(true);
    await repo.upstreams.completeModelsRefreshSuccess(record.id, 'abandoned');
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'racer', now + 900_002, now + 2, false)).resolves.toBe(false);

    const next = { ...record, updatedAt: '2026-08-01T00:01:00.000Z' };
    await repo.upstreams.saveClearingModelsCache(next);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'old-generation', now + 900_003, now + 3, false)).resolves.toBe(false);
    await expect(repo.upstreams.claimModelsRefresh(record.id, { ...generation, updatedAt: next.updatedAt }, 'current', now + 900_003, now + 3, false)).resolves.toBe(true);
  });
});
