import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
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

    const first = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'claim-0', now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null });
    expect(first).toEqual({ kind: 'claimed', failureCount: 0 });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'racer', now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'active', token: 'claim-0' });

    const delays = [1, 2, 4, 8, 16, 32, 60, 60].map(minutes => minutes * 60_000);
    if (first.kind !== 'claimed') throw new Error('expected refresh claim');
    let claim = first;
    for (const [index, delay] of delays.entries()) {
      const retryAt = modelsRefreshRetryAt(now, claim.failureCount);
      expect(retryAt - now).toBe(delay);
      await repo.upstreams.finalizeModelsRefreshFailure(record.id, generation, `claim-${index}`, { message: 'failure', at: now }, claim.failureCount + 1, retryAt);
      await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: `early-${index}`, now: retryAt - 1, staleClaimedBefore: retryAt - 900_001, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'backoff' });
      now = retryAt;
      const nextClaim = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: `claim-${index + 1}`, now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null });
      if (nextClaim.kind !== 'claimed') throw new Error('expected refresh claim');
      claim = nextClaim;
      expect(claim.failureCount).toBe(index + 1);
    }

    const blockedUntil = modelsRefreshRetryAt(now, claim.failureCount);
    await repo.upstreams.finalizeModelsRefreshFailure(record.id, generation, `claim-${delays.length}`, { message: 'failure', at: now }, claim.failureCount + 1, blockedUntil);
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'forced', now: now + 1, staleClaimedBefore: now - 899_999, force: true, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: delays.length + 1 });
    await repo.upstreams.finalizeModelsRefreshSuccess(record.id, generation, 'forced', { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, models: [] });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'after-success', now: now + 2, staleClaimedBefore: now - 899_998, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
  });

  test('recovers abandoned claims and fences tokens, timestamps, and config', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;

    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'abandoned', now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'replacement', now: now + 900_001, staleClaimedBefore: now + 1, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
    await repo.upstreams.finalizeModelsRefreshSuccess(record.id, generation, 'abandoned', { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 900_001, models: [] });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'racer', now: now + 900_002, staleClaimedBefore: now + 2, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'active', token: 'replacement' });

    const next = { ...record, config: { tenant: 'next' } };
    await repo.upstreams.saveClearingModelsCache(next);
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'old-config', now: now + 900_003, staleClaimedBefore: now + 3, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'generation-mismatch' });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation: { updatedAt: next.updatedAt, config: next.config }, token: 'current', now: now + 900_003, staleClaimedBefore: now + 3, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });

    const newer = { ...next, updatedAt: '2026-08-01T00:01:00.000Z' };
    await repo.upstreams.saveClearingModelsCache(newer);
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation: { updatedAt: next.updatedAt, config: next.config }, token: 'old-time', now: now + 900_004, staleClaimedBefore: now + 4, force: false, observedActiveToken: null })).resolves.toEqual({ kind: 'generation-mismatch' });
  });

  test('metadata saves preserve backoff while invalidating an active owner', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;
    const claim = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'failed', now, staleClaimedBefore: now - 900_000, force: false, observedActiveToken: null });
    if (claim.kind !== 'claimed') throw new Error('expected refresh claim');
    await repo.upstreams.finalizeModelsRefreshFailure(record.id, generation, 'failed', { message: 'failure', at: now }, 1, modelsRefreshRetryAt(now, 0));

    const next = { ...record, name: 'Renamed', updatedAt: '2026-08-01T00:01:00.000Z' };
    await repo.upstreams.save(next);
    await expect(repo.upstreams.claimModelsRefresh({
      id: record.id,
      generation: { updatedAt: next.updatedAt, config: next.config },
      token: 'next-generation',
      now: now + 1,
      staleClaimedBefore: now - 899_999,
      force: false,
      observedActiveToken: null,
    })).resolves.toEqual({ kind: 'backoff' });
  });
});
