import { getDumpStore } from './dump/registry.ts';
import { getRepo } from './repo/index.ts';
import { sweepResponsesState } from './repo/responses-maintenance.ts';
import { getImageCacheStore } from '@floway-dev/platform';

const HOUR_MS = 60 * 60 * 1000;
const DUMP_KEYS_PER_TICK = 15;

const runSweep = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[scheduled] ${name} failed`, err);
    return false;
  }
};

const sweepExpiredDumps = async (now: number): Promise<void> => {
  const store = getDumpStore();
  // Rotate a bounded slice across all active keys. Disabled keys stay in the
  // rotation because an accumulator opened before the toggle can still land a
  // late row; repeated bounded batches fold those rows and orphan files up.
  const keys = await getRepo().apiKeys.listMaintenancePage(Math.floor(now / HOUR_MS), DUMP_KEYS_PER_TICK);
  for (const key of keys) {
    try {
      await store.purgeMaintenanceBatch(key.id, key.dumpRetentionSeconds, now);
    } catch (err) {
      console.error('[scheduled] dump sweep failed', key.id, err);
    }
  }
};

export const runScheduledStateMaintenance = async (): Promise<void> => {
  const nowMs = Date.now();
  const responsesStateHealthy = await runSweep('responsesState.sweep', () => sweepResponsesState(nowMs));
  if (!responsesStateHealthy) return;
  await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs));
};

export const runScheduledDumpMaintenance = async (): Promise<void> => {
  const nowMs = Date.now();
  await runSweep('dumps.sweepExpired', () => sweepExpiredDumps(nowMs));
};

export const runScheduledMaintenance = async (): Promise<void> => {
  await runScheduledStateMaintenance();
  await runScheduledDumpMaintenance();
};
