import { getRepo } from './index.ts';
import { deleteLegacyResponsesItemPayloadExpiryBucket, deleteResponsesItemPayloadExpiryBucket } from './responses-payload.ts';

const HOUR_MS = 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 100;
const D1_MUTATIONS_PER_CURSOR = 10;

export const sweepResponsesState = async (now: number): Promise<void> => {
  const repo = getRepo();
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  await sweepLegacyState(currentHour);
  let expiryHour = await repo.responsesMaintenance.getNextExpiryHour();
  let mutations = 0;

  while (expiryHour < currentHour && mutations < D1_MUTATIONS_PER_CURSOR) {
    const hourEnd = expiryHour + HOUR_MS;
    const deletedSnapshots = await repo.responsesSnapshots.deleteExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedSnapshots === DELETE_BATCH_SIZE) continue;
    if (mutations >= D1_MUTATIONS_PER_CURSOR) return;

    const deletedItems = await repo.responsesItems.deleteExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedItems === DELETE_BATCH_SIZE) continue;
    if (mutations >= D1_MUTATIONS_PER_CURSOR) return;

    await deleteResponsesItemPayloadExpiryBucket(expiryHour);
    await repo.responsesMaintenance.setNextExpiryHour(hourEnd);
    mutations += 1;
    expiryHour = hourEnd;
  }
};

const sweepLegacyState = async (currentHour: number): Promise<void> => {
  const repo = getRepo();
  const initialExpiryHour = await repo.responsesMaintenance.getLegacyNextExpiryHour();
  if (initialExpiryHour === null) return;
  let expiryHour: number = initialExpiryHour;
  let mutations = 0;

  while (expiryHour < currentHour && mutations < D1_MUTATIONS_PER_CURSOR) {
    const hourEnd = expiryHour + HOUR_MS;
    const deletedSnapshots = await repo.responsesMaintenance.deleteLegacySnapshotsExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedSnapshots === DELETE_BATCH_SIZE) continue;
    if (mutations >= D1_MUTATIONS_PER_CURSOR) return;

    const deletedItems = await repo.responsesMaintenance.deleteLegacyItemsExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedItems === DELETE_BATCH_SIZE) continue;
    if (mutations >= D1_MUTATIONS_PER_CURSOR) return;

    await deleteLegacyResponsesItemPayloadExpiryBucket(expiryHour);
    await repo.responsesMaintenance.setLegacyNextExpiryHour(hourEnd);
    mutations += 1;
    expiryHour = hourEnd;
  }

  if (expiryHour >= currentHour) await repo.responsesMaintenance.completeLegacyCleanupIfEmpty();
};
