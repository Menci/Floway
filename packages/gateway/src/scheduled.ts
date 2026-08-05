import { sweepExpirations } from './scheduled/expiration-sweeps.ts';
import { refreshModelsCaches } from './scheduled/models-refresh.ts';
import { collectSpilledFiles } from './scheduled/spilled-files.ts';
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

export const runScheduledMaintenance = async (runtimeLocation = 'SCHEDULED'): Promise<void> => {
  const nowMs = Date.now();
  await runSweep('models.refresh', () => refreshModelsCaches(runtimeLocation));
  await runSweep('expirations.sweep', () => sweepExpirations(nowMs));
  await runSweep('spilledFiles.collect', () => collectSpilledFiles(nowMs));
  await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs));
};
