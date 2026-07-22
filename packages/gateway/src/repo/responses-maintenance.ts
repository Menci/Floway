import { getRepo } from './index.ts';
import { deleteAllLegacyResponsesItemPayloadFiles, deleteLegacyResponsesItemPayloadExpiryBucket } from './responses-payload.ts';
import { getFileProvider } from '@floway-dev/platform';

const HOUR_MS = 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 100;
const CURRENT_ROW_MUTATIONS_PER_TICK = 8;
const LEGACY_MUTATIONS_PER_TICK = 10;
const PAYLOAD_GC_BATCH_SIZE = 1_000;
const PAYLOAD_GC_CLAIM_TIMEOUT_MS = 60 * 60 * 1000;

export const sweepResponsesState = async (now: number): Promise<void> => {
  const repo = getRepo();
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  await sweepLegacyState(currentHour, now);
  let mutations = 0;

  while (mutations < CURRENT_ROW_MUTATIONS_PER_TICK) {
    const deletedSnapshots = await repo.responsesSnapshots.deleteExpired(now, DELETE_BATCH_SIZE);
    mutations += 1;
    if (deletedSnapshots === DELETE_BATCH_SIZE) continue;
    if (mutations >= CURRENT_ROW_MUTATIONS_PER_TICK) break;

    const deletedItems = await repo.responsesItems.deleteExpired(now, DELETE_BATCH_SIZE);
    mutations += 1;
    if (deletedItems === DELETE_BATCH_SIZE) continue;
    break;
  }

  await sweepPayloadGarbage(now);
};

const sweepPayloadGarbage = async (now: number): Promise<void> => {
  const repo = getRepo();
  const token = crypto.randomUUID();
  const keys = await repo.responsesMaintenance.claimPayloadFiles(
    token,
    now,
    now - PAYLOAD_GC_CLAIM_TIMEOUT_MS,
    PAYLOAD_GC_BATCH_SIZE,
  );
  if (keys.length === 0) return;
  await getFileProvider().deleteKeys(keys);
  const acknowledged = await repo.responsesMaintenance.acknowledgePayloadFiles(token);
  if (acknowledged !== keys.length) {
    throw new Error(`Responses payload GC acknowledged ${acknowledged} of ${keys.length} claimed files`);
  }
};

const sweepLegacyState = async (currentHour: number, now: number): Promise<void> => {
  const repo = getRepo();
  const initialExpiryHour = await repo.responsesMaintenance.getLegacyNextExpiryHour();
  if (initialExpiryHour === null) return;
  let expiryHour: number = initialExpiryHour;
  let mutations = 0;

  while (expiryHour < currentHour && mutations < LEGACY_MUTATIONS_PER_TICK) {
    const hourEnd = expiryHour + HOUR_MS;
    const deletedSnapshots = await repo.responsesMaintenance.deleteLegacySnapshotsExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedSnapshots === DELETE_BATCH_SIZE) continue;
    if (mutations >= LEGACY_MUTATIONS_PER_TICK) return;

    const deletedItems = await repo.responsesMaintenance.deleteLegacyItemsExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedItems === DELETE_BATCH_SIZE) continue;
    if (mutations >= LEGACY_MUTATIONS_PER_TICK) return;

    await deleteLegacyResponsesItemPayloadExpiryBucket(expiryHour);
    await repo.responsesMaintenance.setLegacyNextExpiryHour(hourEnd);
    mutations += 1;
    expiryHour = hourEnd;
  }

  if (expiryHour >= currentHour && await repo.responsesMaintenance.isLegacyCleanupReady(now)) {
    await deleteAllLegacyResponsesItemPayloadFiles();
    await repo.responsesMaintenance.completeLegacyCleanup();
  }
};
