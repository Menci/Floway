import { getRepo } from './index.ts';

export const purgeResponsesState = async (apiKeyId: string): Promise<void> => {
  const repo = getRepo();
  await repo.responsesSnapshots.deleteByApiKey(apiKeyId);
  await repo.responsesItems.deleteByApiKey(apiKeyId);
};

export const sweepResponsesState = async (now: number): Promise<void> => {
  const repo = getRepo();
  for (const key of await repo.apiKeys.listIncludingDeleted()) {
    if (key.deletedAt !== null || key.responsesRetentionSeconds === 0) {
      await purgeResponsesState(key.id);
      continue;
    }
    await repo.responsesSnapshots.deleteInactive(key.id, key.responsesStateEpoch, now);
    await repo.responsesItems.deleteInactive(key.id, key.responsesStateEpoch, now);
  }
};
