import { getDumpStore } from '../dump/registry.ts';
import { getRepo } from '../repo/index.ts';
import { OPENAI_RESPONSES_REFRESH_GRANULARITY_MS } from '../repo/openai-responses-retention.ts';
import type { ExpirationDomain, ExpirationSweepCompletion } from '../repo/types.ts';

const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
const ERROR_RETRY_MS = 60 * 1000;
const PARTIAL_RETRY_MS = 1;
const OPENAI_RESPONSES_DELETE_BATCH_SIZE = 100;
const DUMP_DELETE_BATCH_SIZE = 50;
export const SWEEP_UNITS_PER_TICK = 4;
export const MAX_FILES_RETIRED_PER_SWEEP_UNIT = Math.max(
  OPENAI_RESPONSES_DELETE_BATCH_SIZE,
  DUMP_DELETE_BATCH_SIZE * 2,
);
const BACKFILL_ROWS_PER_TICK = 500;

interface ExpirationAdapter {
  sweepKey(keyId: string, now: number): Promise<ExpirationSweepCompletion>;
}

const findNextOpenAIResponsesCleanupAt = async (keyId: string): Promise<number | null> => {
  const repo = getRepo();
  const key = await repo.apiKeys.getById(keyId);
  if (key === null || key.openaiResponsesRetentionSeconds === 0) return null;
  const [itemRefresh, snapshotRefresh] = await Promise.all([
    repo.openaiResponsesItems.findOldestRefreshedAt(keyId),
    repo.openaiResponsesSnapshots.findOldestRefreshedAt(keyId),
  ]);
  const oldest = [itemRefresh, snapshotRefresh].filter((value): value is number => value !== null);
  return oldest.length === 0
    ? null
    : Math.min(...oldest) + key.openaiResponsesRetentionSeconds * 1000 + OPENAI_RESPONSES_REFRESH_GRANULARITY_MS + 1;
};

const openaiResponsesAdapter: ExpirationAdapter = {
  async sweepKey(keyId, now) {
    const repo = getRepo();
    const deletedSnapshots = await repo.openaiResponsesSnapshots.deleteExpiredBatch(keyId, now, OPENAI_RESPONSES_DELETE_BATCH_SIZE);
    const deletedItems = await repo.openaiResponsesItems.deleteExpiredBatch(keyId, now, OPENAI_RESPONSES_DELETE_BATCH_SIZE);
    if (deletedSnapshots === OPENAI_RESPONSES_DELETE_BATCH_SIZE || deletedItems === OPENAI_RESPONSES_DELETE_BATCH_SIZE) {
      return { kind: 'partial', retryAt: now + PARTIAL_RETRY_MS };
    }
    return { kind: 'drained', nextDueAt: await findNextOpenAIResponsesCleanupAt(keyId) };
  },
};

const dumpsAdapter: ExpirationAdapter = {
  async sweepKey(keyId, now) {
    const store = getDumpStore();
    const deleted = await store.deleteExpiredBatch(keyId, now, DUMP_DELETE_BATCH_SIZE);
    if (deleted === DUMP_DELETE_BATCH_SIZE) return { kind: 'partial', retryAt: now + PARTIAL_RETRY_MS };
    const key = await getRepo().apiKeys.getById(keyId);
    const retentionSeconds = key?.dumpRetentionSeconds ?? null;
    if (retentionSeconds === null) return { kind: 'drained', nextDueAt: null };
    const oldest = await store.findOldestCreatedAt(keyId);
    return {
      kind: 'drained',
      nextDueAt: oldest === null ? null : oldest + retentionSeconds * 1000 + 1,
    };
  },
};

const adapters: Record<ExpirationDomain, ExpirationAdapter> = {
  responses: openaiResponsesAdapter,
  dumps: dumpsAdapter,
};

export const sweepExpirations = async (now: number): Promise<void> => {
  const repo = getRepo();
  await repo.expirationSweeps.backfillCleanupTracking(BACKFILL_ROWS_PER_TICK);
  for (let index = 0; index < SWEEP_UNITS_PER_TICK; index += 1) {
    const token = crypto.randomUUID();
    const claim = await repo.expirationSweeps.claim(token, now, now - CLAIM_TIMEOUT_MS);
    if (claim === null) break;
    try {
      const result = await adapters[claim.domain].sweepKey(claim.keyId, now);
      await repo.expirationSweeps.complete(token, claim.revision, result);
    } catch (error) {
      await repo.expirationSweeps.complete(token, claim.revision, { kind: 'partial', retryAt: now + ERROR_RETRY_MS });
      console.error(`[scheduled] ${claim.domain} expiration failed`, claim.keyId, error);
    }
  }
};
