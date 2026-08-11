import { getRepo } from './repo/index.ts';
import type { ScheduledMaintenanceRepo } from './repo/types.ts';
import { sweepExpirations } from './scheduled/expiration-sweeps.ts';
import { collectSpilledFiles } from './scheduled/spilled-files.ts';
import { getImageCacheStore } from '@floway-dev/platform';

const MAINTENANCE_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const MAINTENANCE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

const startMaintenanceHeartbeat = (maintenance: ScheduledMaintenanceRepo, token: string): {
  assertOwned(): Promise<void>;
  stop(): Promise<void>;
} => {
  let renewal = Promise.resolve();
  let failure: { error: unknown } | null = null;
  const renew = (): void => {
    renewal = renewal.then(async () => {
      if (failure !== null) return;
      try {
        await maintenance.renew(token, Date.now());
      } catch (error) {
        failure = { error };
      }
    });
  };
  const timer = setInterval(renew, MAINTENANCE_HEARTBEAT_INTERVAL_MS);
  return {
    async assertOwned() {
      renew();
      await renewal;
      if (failure !== null) throw failure.error;
    },
    async stop() {
      clearInterval(timer);
      await renewal;
    },
  };
};

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
  const maintenance = getRepo().scheduledMaintenance;
  if (!await maintenance.tryClaim(token, nowMs, nowMs - MAINTENANCE_CLAIM_TIMEOUT_MS)) return;
  const heartbeat = startMaintenanceHeartbeat(maintenance, token);
  try {
    await runSweep('expirations.sweep', () => sweepExpirations(nowMs));
    await heartbeat.assertOwned();
    await runSweep('spilledFiles.collect', () => collectSpilledFiles(nowMs));
    await heartbeat.assertOwned();
    await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(nowMs));
  } finally {
    await heartbeat.stop();
    await maintenance.release(token);
  }
};
