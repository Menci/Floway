import { getRepo } from './index.ts';
import type { ExpirationDomain } from './types.ts';
import { getDumpStore } from '../dump/registry.ts';

const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
const PARTIAL_RETRY_MS = 1;
const DELETE_BATCH_SIZE = 100;
const SWEEP_UNITS_PER_TICK = 4;
const DUMP_BACKFILL_BATCH_SIZE = 500;

interface ExpirationAdapter {
  sweepKey(keyId: string, now: number): Promise<{ nextDueAt: number | null; advanceOnConflict: boolean }>;
}

const nextResponsesDueAt = async (keyId: string): Promise<number | null> => {
  const repo = getRepo();
  const key = await repo.apiKeys.getById(keyId);
  if (key === null || key.responsesRetentionSeconds === 0) return null;
  const [itemRefresh, snapshotRefresh] = await Promise.all([
    repo.responsesItems.findOldestRefresh(keyId),
    repo.responsesSnapshots.findOldestRefresh(keyId),
  ]);
  const oldest = [itemRefresh, snapshotRefresh].filter((value): value is number => value !== null);
  return oldest.length === 0 ? null : Math.min(...oldest) + key.responsesRetentionSeconds * 1000 + 1;
};

const responsesAdapter: ExpirationAdapter = {
  async sweepKey(keyId, now) {
    const repo = getRepo();
    const deletedSnapshots = await repo.responsesSnapshots.deleteExpiredBatch(keyId, now, DELETE_BATCH_SIZE);
    const deletedItems = await repo.responsesItems.deleteExpiredBatch(keyId, now, DELETE_BATCH_SIZE);
    if (deletedSnapshots === DELETE_BATCH_SIZE || deletedItems === DELETE_BATCH_SIZE) {
      return { nextDueAt: now + PARTIAL_RETRY_MS, advanceOnConflict: true };
    }
    return { nextDueAt: await nextResponsesDueAt(keyId), advanceOnConflict: false };
  },
};

const dumpsAdapter: ExpirationAdapter = {
  async sweepKey(keyId, now) {
    const store = getDumpStore();
    const deleted = await store.deleteExpiredBatch(keyId, now, DELETE_BATCH_SIZE);
    if (deleted === DELETE_BATCH_SIZE) return { nextDueAt: now + PARTIAL_RETRY_MS, advanceOnConflict: true };
    const key = await getRepo().apiKeys.getById(keyId);
    const retentionSeconds = key?.dumpRetentionSeconds ?? null;
    if (retentionSeconds === null) return { nextDueAt: null, advanceOnConflict: false };
    const oldest = await store.findOldestCreatedAt(keyId);
    return {
      nextDueAt: oldest === null ? null : oldest + retentionSeconds * 1000 + 1,
      advanceOnConflict: false,
    };
  },
};

const adapters: Record<ExpirationDomain, ExpirationAdapter> = {
  responses: responsesAdapter,
  dumps: dumpsAdapter,
};

export const sweepExpirations = async (now: number): Promise<void> => {
  const repo = getRepo();
  await repo.expirationSweeps.backfillDumpKeys(DUMP_BACKFILL_BATCH_SIZE);
  for (let index = 0; index < SWEEP_UNITS_PER_TICK; index += 1) {
    const token = crypto.randomUUID();
    const claim = await repo.expirationSweeps.claim(token, now, now - CLAIM_TIMEOUT_MS);
    if (claim === null) return;
    try {
      const result = await adapters[claim.domain].sweepKey(claim.keyId, now);
      await repo.expirationSweeps.complete(token, claim.revision, result.nextDueAt, result.advanceOnConflict);
    } catch (error) {
      await repo.expirationSweeps.complete(token, claim.revision, now + ERROR_RETRY_MS, true);
      console.error(`[scheduled] ${claim.domain} expiration failed`, claim.keyId, error);
    }
  }
};
