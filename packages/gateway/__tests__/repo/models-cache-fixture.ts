import type { ModelsCacheGeneration, UpstreamRepo } from '../../src/repo/types.ts';
import type { UpstreamModelsCache } from '@floway-dev/provider';

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  generation: ModelsCacheGeneration,
  cache: Omit<UpstreamModelsCache, 'lastError'>,
): Promise<boolean> => {
  const token = crypto.randomUUID();
  const claim = await repo.claimModelsRefresh(id, generation, token, Date.now(), Number.MIN_SAFE_INTEGER, true);
  if (claim.kind !== 'claimed') return false;
  const saved = await repo.saveClaimedModelsCache(id, generation, token, cache);
  await repo.completeModelsRefreshSuccess(id, token);
  return saved;
};

export const seedModelsCacheError = async (
  repo: UpstreamRepo,
  id: string,
  generation: ModelsCacheGeneration,
  error: NonNullable<UpstreamModelsCache['lastError']>,
): Promise<boolean> => {
  const token = crypto.randomUUID();
  const claim = await repo.claimModelsRefresh(id, generation, token, Date.now(), Number.MIN_SAFE_INTEGER, true);
  if (claim.kind !== 'claimed') return false;
  const saved = await repo.saveClaimedModelsCacheError(id, generation, token, error);
  await repo.completeModelsRefreshSuccess(id, token);
  return saved;
};
