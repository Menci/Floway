import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { modelsRefreshRetryAt } from '../../src/repo/models-refresh-contract.ts';
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
  config: { tenant: 'current' },
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
  test('claims atomically, applies one backoff schedule, and lets force bypass cooldown', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    let now = 1_800_000_000_000;

    const first = await repo.upstreams.claimModelsRefresh(record.id, generation, 'claim-0', now, now - 900_000, false);
    expect(first).toEqual({ failureCount: 0 });
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'racer', now, now - 900_000, false)).resolves.toBeNull();

    const delays = [1, 2, 4, 8, 16, 32, 60, 60].map(minutes => minutes * 60_000);
    let claim = first!;
    for (const [index, delay] of delays.entries()) {
      const retryAt = modelsRefreshRetryAt(now, claim.failureCount);
      expect(retryAt - now).toBe(delay);
      await repo.upstreams.completeModelsRefreshFailure(record.id, `claim-${index}`, claim.failureCount + 1, retryAt);
      await expect(repo.upstreams.claimModelsRefresh(record.id, generation, `early-${index}`, retryAt - 1, retryAt - 900_001, false)).resolves.toBeNull();
      now = retryAt;
      claim = (await repo.upstreams.claimModelsRefresh(record.id, generation, `claim-${index + 1}`, now, now - 900_000, false))!;
      expect(claim.failureCount).toBe(index + 1);
    }

    const blockedUntil = modelsRefreshRetryAt(now, claim.failureCount);
    await repo.upstreams.completeModelsRefreshFailure(record.id, `claim-${delays.length}`, claim.failureCount + 1, blockedUntil);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'forced', now + 1, now - 899_999, true)).resolves.toEqual({ failureCount: delays.length + 1 });
    await repo.upstreams.completeModelsRefreshSuccess(record.id, 'forced');
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'after-success', now + 2, now - 899_998, false)).resolves.toEqual({ failureCount: 0 });
  });

  test('recovers abandoned claims and fences tokens, timestamps, and config', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;

    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'abandoned', now, now - 900_000, false)).resolves.toEqual({ failureCount: 0 });
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'replacement', now + 900_001, now + 1, false)).resolves.toEqual({ failureCount: 0 });
    await repo.upstreams.completeModelsRefreshSuccess(record.id, 'abandoned');
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'racer', now + 900_002, now + 2, false)).resolves.toBeNull();

    const next = { ...record, config: { tenant: 'next' } };
    await repo.upstreams.saveClearingModelsCache(next);
    await expect(repo.upstreams.claimModelsRefresh(record.id, generation, 'old-config', now + 900_003, now + 3, false)).resolves.toBeNull();
    await expect(repo.upstreams.claimModelsRefresh(record.id, { updatedAt: next.updatedAt, config: next.config }, 'current', now + 900_003, now + 3, false)).resolves.toEqual({ failureCount: 0 });

    const newer = { ...next, updatedAt: '2026-08-01T00:01:00.000Z' };
    await repo.upstreams.saveClearingModelsCache(newer);
    await expect(repo.upstreams.claimModelsRefresh(record.id, { updatedAt: next.updatedAt, config: next.config }, 'old-time', now + 900_004, now + 4, false)).resolves.toBeNull();
  });
});
