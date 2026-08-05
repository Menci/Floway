import { sweepExpirations } from './scheduled/expiration-sweeps.ts';
import { refreshModelsCaches } from './scheduled/models-refresh.ts';
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

const defaultBackgroundScheduler: BackgroundScheduler = promise => {
  promise.catch(error => console.error('[scheduled] background task failed', error));
};

export const runScheduledMaintenance = async (
  runtimeLocation = 'SCHEDULED',
  backgroundScheduler: BackgroundScheduler = defaultBackgroundScheduler,
): Promise<void> => {
  const nowMs = Date.now();
  await Promise.all([
    runSweep('models.refresh', () => refreshModelsCaches(runtimeLocation, backgroundScheduler)),
    runSweep('expirations.sweep', () => sweepExpirations(nowMs)),
    runSweep('spilledFiles.collect', () => collectSpilledFiles(nowMs)),
    runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs)),
  ]);
};
