import { modelsCacheGeneration } from '../../src/repo/models-cache-contract.ts';
import type { ModelsCacheGeneration, UpstreamRepo } from '../../src/repo/types.ts';
import type { UpstreamModelsCache } from '@floway-dev/provider';

export const storedModelsCacheGeneration = async (
  repo: UpstreamRepo,
  id: string,
): Promise<ModelsCacheGeneration> => {
  const record = await repo.getById(id);
  if (record === null) throw new Error(`Upstream ${id} not found`);
  return modelsCacheGeneration(record);
};

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  generation: ModelsCacheGeneration,
  cache: Omit<UpstreamModelsCache, 'lastError'>,
): Promise<boolean> => {
  return await repo.publishModelsRefresh({ id, generation, cache });
};

export const seedModelsCacheError = async (
  repo: UpstreamRepo,
  id: string,
  generation: ModelsCacheGeneration,
  error: NonNullable<UpstreamModelsCache['lastError']>,
): Promise<boolean> => {
  return await repo.recordModelsRefreshFailure({ id, generation, error, previousFailureCount: 0, failedAt: -60_000 });
};
