import { getDumpStore } from './dump/registry.ts';
import { sweepResponsesState } from './repo/responses-maintenance.ts';
import { getImageCacheStore } from '@floway-dev/platform';

const DUMP_UNITS_PER_TICK = 4;

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
  await store.backfillMaintenanceBatch();
  for (let index = 0; index < DUMP_UNITS_PER_TICK; index += 1) {
    if (!await store.purgeNextMaintenanceBatch(now)) return;
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
