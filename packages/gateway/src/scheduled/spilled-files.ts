import { MAX_FILES_RETIRED_PER_SWEEP_UNIT, SWEEP_UNITS_PER_TICK } from './expiration-sweeps.ts';
import { getRepo } from '../repo/index.ts';
import { getFileStore } from '@floway-dev/platform';

const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
// Matching the collector to the maximum one-tick retirement volume prevents a
// separate, larger D1 write burst while still letting staged orphans drain
// whenever expiration work leaves capacity.
const FILE_DELETE_BATCH_SIZE = MAX_FILES_RETIRED_PER_SWEEP_UNIT * SWEEP_UNITS_PER_TICK;

export const collectSpilledFiles = async (now: number): Promise<void> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  const keys = await repo.spilledFiles.claimCollectible(
    token,
    now,
    now - CLAIM_TIMEOUT_MS,
    FILE_DELETE_BATCH_SIZE,
  );
  if (keys.length === 0) return;
  await getFileStore().deleteKeys(keys);
  const acknowledged = await repo.spilledFiles.acknowledge(token);
  if (acknowledged !== keys.length) {
    throw new Error(`Spilled-file collection acknowledged ${acknowledged} of ${keys.length} claimed files`);
  }
};
