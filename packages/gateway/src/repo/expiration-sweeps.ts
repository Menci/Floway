import { getDumpStore } from '../dump/registry.ts';
import { getRepo } from './index.ts';
import type { ExpirationDomain } from './types.ts';

const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
const DELETE_BATCH_SIZE = 100;
const SWEEP_UNITS_PER_TICK = 4;

interface ExpirationAdapter {
  sweepKey(keyId: string, now: number): Promise<number | null>;
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
    if (deletedSnapshots === DELETE_BATCH_SIZE || deletedItems === DELETE_BATCH_SIZE) return now;
    return await nextResponsesDueAt(keyId);
  },
};

const dumpsAdapter: ExpirationAdapter = {
  async sweepKey(keyId, now) {
    const store = getDumpStore();
    const deleted = await store.deleteExpiredBatch(keyId, now, DELETE_BATCH_SIZE);
    if (deleted === DELETE_BATCH_SIZE) return now;
    const key = await getRepo().apiKeys.getById(keyId);
    if (key === null || key.dumpRetentionSeconds === null) return null;
    const oldest = await store.findOldestCreatedAt(keyId);
    return oldest === null ? null : oldest + key.dumpRetentionSeconds * 1000 + 1;
  },
};

const adapters: Record<ExpirationDomain, ExpirationAdapter> = {
  responses: responsesAdapter,
  dumps: dumpsAdapter,
};

export const sweepExpirations = async (now: number): Promise<void> => {
  const repo = getRepo();
  for (let index = 0; index < SWEEP_UNITS_PER_TICK; index += 1) {
    const token = crypto.randomUUID();
    const claim = await repo.expirationSweeps.claim(token, now, now - CLAIM_TIMEOUT_MS);
    if (claim === null) return;
    try {
      const nextDueAt = await adapters[claim.domain].sweepKey(claim.keyId, now);
      await repo.expirationSweeps.complete(token, claim.revision, nextDueAt);
    } catch (error) {
      await repo.expirationSweeps.complete(token, claim.revision, now + ERROR_RETRY_MS);
      console.error(`[scheduled] ${claim.domain} expiration failed`, claim.keyId, error);
    }
  }
};
