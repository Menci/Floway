import { getRepo } from './index.ts';
import { deleteAllV1ResponsesItemPayloadFiles, deleteV1ResponsesItemPayloadExpiryBucket } from './responses-payload.ts';
import { getFileProvider } from '@floway-dev/platform';

const HOUR_MS = 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 100;
const V1_MUTATIONS_PER_TICK = 10;
const STATE_SWEEP_RETRY_MS = 60 * 1000;
const CLAIM_TIMEOUT_MS = 60 * 60 * 1000;
const PAYLOAD_GC_BATCH_SIZE = 1_000;

export const sweepResponsesState = async (now: number): Promise<void> => {
  await sweepV1State(Math.floor(now / HOUR_MS) * HOUR_MS, now);
  await sweepCurrentState(now);
  await sweepPayloadGarbage(now);
};

const sweepCurrentState = async (now: number): Promise<void> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  const claim = await repo.responsesMaintenance.claimStateSweep(token, now, now - CLAIM_TIMEOUT_MS);
  if (claim === null) return;

  const deletedSnapshots = await repo.responsesSnapshots.deleteReclaimable(claim.apiKeyId, now, DELETE_BATCH_SIZE);
  const deletedItems = await repo.responsesItems.deleteReclaimable(claim.apiKeyId, now, DELETE_BATCH_SIZE);
  if (deletedSnapshots === DELETE_BATCH_SIZE || deletedItems === DELETE_BATCH_SIZE) {
    await repo.responsesMaintenance.completeStateSweep(token, claim.revision, now + STATE_SWEEP_RETRY_MS);
    return;
  }

  const oldest = claim.stateEpoch === null
    ? null
    : await repo.responsesMaintenance.findOldestStateRefresh(claim.apiKeyId, claim.stateEpoch);
  const nextDueAt = oldest === null || claim.retentionSeconds === 0
    ? null
    : oldest + claim.retentionSeconds * 1000 + 1;
  await repo.responsesMaintenance.completeStateSweep(token, claim.revision, nextDueAt);
};

const sweepPayloadGarbage = async (now: number): Promise<void> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  const keys = await repo.responsesMaintenance.claimPayloadFiles(
    token,
    now,
    now - CLAIM_TIMEOUT_MS,
    PAYLOAD_GC_BATCH_SIZE,
  );
  if (keys.length === 0) return;
  await getFileProvider().deleteKeys(keys);
  const acknowledged = await repo.responsesMaintenance.acknowledgePayloadFiles(token);
  if (acknowledged !== keys.length) {
    throw new Error(`Responses payload GC acknowledged ${acknowledged} of ${keys.length} claimed files`);
  }
};

const sweepV1State = async (currentHour: number, now: number): Promise<void> => {
  const repo = getRepo();
  const initialExpiryHour = await repo.responsesMaintenance.getV1NextExpiryHour();
  if (initialExpiryHour === null) return;
  let expiryHour: number = initialExpiryHour;
  let mutations = 0;

  while (expiryHour < currentHour && mutations < V1_MUTATIONS_PER_TICK) {
    const hourEnd = expiryHour + HOUR_MS;
    const deletedSnapshots = await repo.responsesMaintenance.deleteV1SnapshotsExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedSnapshots === DELETE_BATCH_SIZE) continue;
    if (mutations >= V1_MUTATIONS_PER_TICK) return;

    const deletedItems = await repo.responsesMaintenance.deleteV1ItemsExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedItems === DELETE_BATCH_SIZE) continue;
    if (mutations >= V1_MUTATIONS_PER_TICK) return;

    await deleteV1ResponsesItemPayloadExpiryBucket(expiryHour);
    await repo.responsesMaintenance.setV1NextExpiryHour(hourEnd);
    mutations += 1;
    expiryHour = hourEnd;
  }

  if (expiryHour >= currentHour && await repo.responsesMaintenance.isV1CleanupReady(now)) {
    await deleteAllV1ResponsesItemPayloadFiles();
    await repo.responsesMaintenance.completeV1Cleanup();
  }
};
