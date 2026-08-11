import { getRepo } from './repo/index.ts';
import { sweepExpirations } from './scheduled/expiration-sweeps.ts';
import { collectSpilledFiles } from './scheduled/spilled-files.ts';
import { getImageCacheStore } from '@floway-dev/platform';

const MAINTENANCE_CLAIM_TIMEOUT_MS = 60 * 60 * 1000;

const runSweep = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(`[scheduled] ${name} failed`, err);
    return false;
  }
};

export const runScheduledMaintenance = async (): Promise<void> => {
  const nowMs = Date.now();
  const token = crypto.randomUUID();
  const expirationSweeps = getRepo().expirationSweeps;
  if (!await expirationSweeps.tryClaimMaintenance(token, nowMs, nowMs - MAINTENANCE_CLAIM_TIMEOUT_MS)) return;
  try {
    await runSweep('expirations.sweep', () => sweepExpirations(nowMs));
    await runSweep('spilledFiles.collect', () => collectSpilledFiles(nowMs));
    await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs));
  } finally {
    await expirationSweeps.releaseMaintenance(token);
  }
};
