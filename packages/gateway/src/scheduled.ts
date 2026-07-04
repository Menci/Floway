import { getDumpStore } from './dump/registry.ts';
import { getRepo } from './repo/index.ts';
import { RESPONSES_ITEM_PAYLOAD_TTL_MS, startOfUtcHour, sweepExpiredResponsesItemPayloadFiles } from './repo/responses-payload.ts';
import { getImageCacheStore } from '@floway-dev/platform';

// Read only by this scheduled cleanup (deleteOlderThan). Lookups never filter
// by it — a row stays referenceable until cleanup removes it.
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Cursor session scalars track a LIVE conversation turn (the read stream is
// held for at most the DurableHttpSession idle/cap window), so they expire far
// faster than durable history — a stale row only ever causes a clean
// cold-resume, never corruption.
const CURSOR_SESSION_ROW_TTL_MS = 30 * 60 * 1000;

const runSweep = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    console.error(`[scheduled] ${name} failed`, err);
  }
};

export const runScheduledMaintenance = async (): Promise<void> => {
  const now = startOfUtcHour(Date.now());
  await runSweep('responsesItems.clearPayloadOlderThan', () => getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS));
  await runSweep('responsesItems.sweepPayloadFiles', () => sweepExpiredResponsesItemPayloadFiles(now));
  await runSweep('responsesSnapshots.deleteOlderThan', () => getRepo().responsesSnapshots.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS));
  await runSweep('responsesItems.deleteOlderThan', () => getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS));
  await runSweep('cursorSessions.deleteOlderThan', () => getRepo().cursorSessions.deleteOlderThan(Date.now() - CURSOR_SESSION_ROW_TTL_MS));
  await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(Date.now()));
  await runSweep('dumps.sweepExpired', () => sweepExpiredDumps());
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
