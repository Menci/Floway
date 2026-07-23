import { getDumpStore } from './dump/registry.ts';
import { getRepo } from './repo/index.ts';
import { collectSpilledFiles } from './repo/spilled-files.ts';
import { getImageCacheStore } from '@floway-dev/platform';

const runSweep = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[scheduled] ${name} failed`, err);
    return false;
  }
};

const sweepExpiredDumps = async (): Promise<void> => {
  const store = getDumpStore();
  // Iterate every api key, including those with retention disabled. The
  // disabled-retention branch (`purgeAll`) is the only path that catches a
  // record that opened its accumulator before the operator toggled retention
  // off — `openDumpAccumulator` snapshots `dumpRetentionSeconds` at request
  // entry, so an in-flight stream still lands a row after the inline purge
  // at toggle time. Sweeping `purgeAll` on every retention=null key folds
  // those orphans up on the next tick.
  for (const key of await getRepo().apiKeys.list()) {
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

export const runScheduledMaintenance = async (): Promise<void> => {
  const nowMs = Date.now();
  await runSweep('responsesSnapshots.deleteExpired', () => getRepo().responsesSnapshots.deleteExpired(nowMs));
  await runSweep('responsesItems.deleteExpired', () => getRepo().responsesItems.deleteExpired(nowMs));
  await runSweep('spilledFiles.collect', () => collectSpilledFiles(nowMs));
  await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs));
  await runSweep('dumps.sweepExpired', () => sweepExpiredDumps());
};
