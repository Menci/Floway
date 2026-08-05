import type { ModelsCacheGeneration, UpstreamRepo } from '../../src/repo/types.ts';
import type { UpstreamModelsCache } from '@floway-dev/provider';

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  generation: ModelsCacheGeneration,
  cache: Omit<UpstreamModelsCache, 'lastError'>,
): Promise<boolean> => {
  const token = crypto.randomUUID();
  const claim = await repo.claimModelsRefresh({ id, generation, token, now: Date.now(), staleClaimedBefore: Number.MIN_SAFE_INTEGER, force: true, observedActiveToken: null });
  if (claim.kind !== 'claimed') return false;
  return await repo.finalizeModelsRefreshSuccess(id, generation, token, cache);
};

export const seedModelsCacheError = async (
  repo: UpstreamRepo,
  id: string,
  generation: ModelsCacheGeneration,
  error: NonNullable<UpstreamModelsCache['lastError']>,
): Promise<boolean> => {
  const token = crypto.randomUUID();
  const claim = await repo.claimModelsRefresh({ id, generation, token, now: Date.now(), staleClaimedBefore: Number.MIN_SAFE_INTEGER, force: true, observedActiveToken: null });
  if (claim.kind !== 'claimed') return false;
  return await repo.finalizeModelsRefreshFailure(id, generation, token, error, 0, 0);
};
