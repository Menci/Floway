import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { MODEL_CATALOG_REVISION, modelsCacheGeneration } from '../../src/repo/models-cache-contract.ts';
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

const generation: ModelsCacheGeneration = modelsCacheGeneration(record);

const factories: [string, () => Promise<Repo>][] = [
  ['memory', async () => new InMemoryRepo()],
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(factories)('%s models refresh coordination', (_name, createRepo) => {
  test('claims atomically, applies one backoff schedule, and lets force bypass cooldown', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    let now = 1_800_000_000_000;

    const first = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'claim-0', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null });
    expect(first).toEqual({ kind: 'claimed', failureCount: 0 });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'racer', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'active', token: 'claim-0' });

    const delays = [1, 2, 4, 8, 16, 32, 60, 60].map(minutes => minutes * 60_000);
    if (first.kind !== 'claimed') throw new Error('expected refresh claim');
    let claim = first;
    for (const [index, delay] of delays.entries()) {
      const retryAt = modelsRefreshRetryAt(now, claim.failureCount);
      expect(retryAt - now).toBe(delay);
      await repo.upstreams.finalizeModelsRefreshFailure({ id: record.id, generation, token: `claim-${index}`, error: { message: 'failure', at: now }, previousFailureCount: claim.failureCount, failedAt: now });
      await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: `early-${index}`, now: retryAt - 1, staleClaimedBefore: retryAt - 900_001, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'backoff' });
      now = retryAt;
      const nextClaim = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: `claim-${index + 1}`, now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null });
      if (nextClaim.kind !== 'claimed') throw new Error('expected refresh claim');
      claim = nextClaim;
      expect(claim.failureCount).toBe(index + 1);
    }

    await repo.upstreams.finalizeModelsRefreshFailure({ id: record.id, generation, token: `claim-${delays.length}`, error: { message: 'failure', at: now }, previousFailureCount: claim.failureCount, failedAt: now });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'forced', now: now + 1, staleClaimedBefore: now - 899_999, bypassBackoff: true, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: delays.length + 1 });
    await repo.upstreams.finalizeModelsRefreshSuccess({ id: record.id, generation, token: 'forced', cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 1, models: [] } });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'after-success', now: now + 2, staleClaimedBefore: now - 899_998, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
  });

  test('recovers abandoned claims and fences tokens, timestamps, and config', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;

    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'abandoned', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'replacement', now: now + 900_001, staleClaimedBefore: now + 1, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
    await repo.upstreams.finalizeModelsRefreshSuccess({ id: record.id, generation, token: 'abandoned', cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: now + 900_001, models: [] } });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'racer', now: now + 900_002, staleClaimedBefore: now + 2, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'active', token: 'replacement' });

    const next = { ...record, config: { tenant: 'next' } };
    await repo.upstreams.replaceForModels({ previous: record, upstream: next, cachePolicy: 'clear' });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'old-config', now: now + 900_003, staleClaimedBefore: now + 3, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'generation-mismatch' });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation: modelsCacheGeneration(next), token: 'current', now: now + 900_003, staleClaimedBefore: now + 3, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });

    const newer = { ...next, updatedAt: '2026-08-01T00:01:00.000Z' };
    await repo.upstreams.replaceForModels({ previous: next, upstream: newer, cachePolicy: 'clear' });
    await expect(repo.upstreams.claimModelsRefresh({ id: record.id, generation: modelsCacheGeneration(next), token: 'old-time', now: now + 900_004, staleClaimedBefore: now + 4, bypassBackoff: false, observedActiveToken: null })).resolves.toEqual({ kind: 'generation-mismatch' });
  });

  test('metadata saves preserve backoff while invalidating an active owner', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;
    const claim = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'failed', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null });
    if (claim.kind !== 'claimed') throw new Error('expected refresh claim');
    await repo.upstreams.finalizeModelsRefreshFailure({ id: record.id, generation, token: 'failed', error: { message: 'failure', at: now }, previousFailureCount: 0, failedAt: now });

    const next = { ...record, name: 'Renamed', updatedAt: '2026-08-01T00:01:00.000Z' };
    await expect(repo.upstreams.replaceForModels({ previous: record, upstream: next, cachePolicy: 'preserve' })).resolves.toBe(true);
    await expect(repo.upstreams.claimModelsRefresh({
      id: record.id,
      generation: modelsCacheGeneration(next),
      token: 'next-generation',
      now: now + 1,
      staleClaimedBefore: now - 899_999,
      bypassBackoff: false,
      observedActiveToken: null,
    })).resolves.toEqual({ kind: 'backoff' });
  });

  test('operator credential changes preserve the snapshot while resetting refresh cooldown', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const now = 1_800_000_000_000;
    const claim = await repo.upstreams.claimModelsRefresh({ id: record.id, generation, token: 'failed', now, staleClaimedBefore: now - 900_000, bypassBackoff: false, observedActiveToken: null });
    if (claim.kind !== 'claimed') throw new Error('expected refresh claim');
    await repo.upstreams.finalizeModelsRefreshFailure({ id: record.id, generation, token: 'failed', error: { message: 'failure', at: now }, previousFailureCount: 0, failedAt: now });

    const next = { ...record, state: { credential: 'rotated' }, updatedAt: '2026-08-01T00:01:00.000Z' };
    await expect(repo.upstreams.replaceForModels({ previous: record, upstream: next, cachePolicy: 'reset-refresh' })).resolves.toBe(true);
    expect((await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message).toBe('failure');
    await expect(repo.upstreams.claimModelsRefresh({
      id: record.id,
      generation: modelsCacheGeneration(next),
      token: 'new-credential',
      now: now + 1,
      staleClaimedBefore: now - 899_999,
      bypassBackoff: false,
      observedActiveToken: null,
    })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
  });

  test('provider-managed credential state can rotate without invalidating its own owner', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const claim = await repo.upstreams.claimModelsRefresh({
      id: record.id,
      generation,
      token: 'state-owner',
      now: 1_800_000_000_000,
      staleClaimedBefore: 1_799_999_100_000,
      bypassBackoff: false,
      observedActiveToken: null,
    });
    expect(claim.kind).toBe('claimed');
    await repo.upstreams.saveState(record.id, () => ({ credential: 'rotated' }));

    await expect(repo.upstreams.finalizeModelsRefreshSuccess({
      id: record.id,
      generation,
      token: 'state-owner',
      cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 1_800_000_000_001, models: [] },
    })).resolves.toBe(true);
    await expect(repo.upstreams.claimModelsRefresh({
      id: record.id,
      generation,
      token: 'stale-generation',
      now: 1_800_000_000_002,
      staleClaimedBefore: 1_799_999_100_002,
      bypassBackoff: false,
      observedActiveToken: null,
    })).resolves.toEqual({ kind: 'claimed', failureCount: 0 });
  });

  test('catalog-aware replacement rejects a stale control-plane writer', async () => {
    const repo = await createRepo();
    await repo.upstreams.save(record);
    const winner = { ...record, name: 'Winner', updatedAt: '2026-08-01T00:01:00.000Z' };
    const stale = { ...record, name: 'Stale', updatedAt: '2026-08-01T00:02:00.000Z' };

    await expect(repo.upstreams.replaceForModels({ previous: record, upstream: winner, cachePolicy: 'preserve' })).resolves.toBe(true);
    await expect(repo.upstreams.replaceForModels({ previous: record, upstream: stale, cachePolicy: 'clear' })).resolves.toBe(false);
    expect((await repo.upstreams.getById(record.id))?.name).toBe('Winner');
  });
});
