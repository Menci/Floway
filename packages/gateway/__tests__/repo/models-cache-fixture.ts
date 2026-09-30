import { modelsRefreshInputs } from '../../src/repo/models-refresh-inputs.ts';
import type { ModelsRefreshIdentity, UpstreamRepo } from '../../src/repo/types.ts';
import type { UpstreamModelsCache, UpstreamRecord } from '@floway-dev/provider';

type ModelsRefreshRowIdentity = Omit<ModelsRefreshIdentity, 'id'>;

export const modelsRefreshIdentity = (record: UpstreamRecord & { configVersion: number }): ModelsRefreshRowIdentity => ({
  configVersion: record.configVersion,
  cacheEpoch: record.modelsCache?.fetchedAt ?? 0,
  refreshInputs: modelsRefreshInputs(record),
});

export const storedModelsRefreshIdentity = async (
  repo: UpstreamRepo,
  id: string,
): Promise<ModelsRefreshRowIdentity> => {
  const record = await repo.getById(id);
  if (record === null) throw new Error(`Upstream ${id} not found`);
  return modelsRefreshIdentity(record);
};

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  identity: ModelsRefreshRowIdentity,
  cache: Omit<UpstreamModelsCache, 'lastError'>,
): Promise<boolean> => {
  return await repo.publishModelsRefresh({ id, ...identity, cache });
};

export const seedModelsCacheError = async (
  repo: UpstreamRepo,
  id: string,
  identity: ModelsRefreshRowIdentity,
  error: Pick<NonNullable<UpstreamModelsCache['lastError']>, 'message' | 'at'>,
): Promise<boolean> => {
  return await repo.recordModelsRefreshFailure({ id, ...identity, error, previousFailureCount: 0 });
};
