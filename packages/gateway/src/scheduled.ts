import { getDumpStore } from './dump/registry.ts';
import { getRepo } from './repo/index.ts';
import { sweepResponsesState } from './repo/responses-maintenance.ts';
import { getImageCacheStore } from '@floway-dev/platform';

const HOUR_MS = 60 * 60 * 1000;
const DUMP_KEYS_PER_TICK = 20;

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
  // Iterate every api key, including those with retention disabled. The
  // disabled-retention branch (`purgeAll`) is the only path that catches a
  // record that opened its accumulator before the operator toggled retention
  // off — `openDumpAccumulator` snapshots `dumpRetentionSeconds` at request
  // entry, so an in-flight stream still lands a row after the inline purge
  // at toggle time. Sweeping `purgeAll` on every retention=null key folds
  // those orphans up on the next tick.
  const keys = (await getRepo().apiKeys.list()).toSorted((a, b) => a.id.localeCompare(b.id));
  const count = Math.min(keys.length, DUMP_KEYS_PER_TICK);
  const start = keys.length === 0 ? 0 : (Math.floor(now / HOUR_MS) * DUMP_KEYS_PER_TICK) % keys.length;
  for (let offset = 0; offset < count; offset += 1) {
    const key = keys[(start + offset) % keys.length];
    try {
      if (key.dumpRetentionSeconds === null) {
        await store.purgeAll(key.id);
      } else {
        await store.purgeExpired(key.id, key.dumpRetentionSeconds);
      }
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
