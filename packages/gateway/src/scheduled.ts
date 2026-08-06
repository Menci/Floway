import { sweepExpirations } from './scheduled/expiration-sweeps.ts';
import { scheduleModelsCacheRefreshes } from './scheduled/models-refresh.ts';
import { collectSpilledFiles } from './scheduled/spilled-files.ts';
import { getImageCacheStore, type BackgroundScheduler } from '@floway-dev/platform';

const runSweep = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[scheduled] ${name} failed`, err);
    return false;
  }
};

export const runScheduledMaintenance = async (
  runtimeLocation: string | null,
  backgroundScheduler: BackgroundScheduler,
): Promise<void> => {
  const nowMs = Date.now();
  const storageMaintenance = async (): Promise<void> => {
    await runSweep('expirations.sweep', () => sweepExpirations(nowMs));
    await runSweep('spilledFiles.collect', () => collectSpilledFiles(nowMs));
  };
  await Promise.all([
    runSweep('models.refresh', () => scheduleModelsCacheRefreshes(runtimeLocation, backgroundScheduler)),
    storageMaintenance(),
    runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs)),
  ]);
};
