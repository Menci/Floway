import { getRepo } from './index.ts';
import { deleteResponsesItemPayloadExpiryBucket } from './responses-payload.ts';

const HOUR_MS = 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 100;
const MAX_D1_MUTATIONS_PER_TICK = 20;

export const sweepResponsesState = async (now: number): Promise<void> => {
  const repo = getRepo();
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  let expiryHour = await repo.responsesMaintenance.getNextExpiryHour();
  let mutations = 0;

  while (expiryHour < currentHour && mutations < MAX_D1_MUTATIONS_PER_TICK) {
    const hourEnd = expiryHour + HOUR_MS;
    const deletedSnapshots = await repo.responsesSnapshots.deleteExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedSnapshots === DELETE_BATCH_SIZE) continue;
    if (mutations >= MAX_D1_MUTATIONS_PER_TICK) return;

    const deletedItems = await repo.responsesItems.deleteExpiredHour(
      expiryHour,
      hourEnd,
      DELETE_BATCH_SIZE,
    );
    mutations += 1;
    if (deletedItems === DELETE_BATCH_SIZE) continue;
    if (mutations >= MAX_D1_MUTATIONS_PER_TICK) return;

    await deleteResponsesItemPayloadExpiryBucket(expiryHour);
    await repo.responsesMaintenance.setNextExpiryHour(hourEnd);
    mutations += 1;
    expiryHour = hourEnd;
  }
};
