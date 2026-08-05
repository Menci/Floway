import { modelsFetchIdentity } from '../../data-plane/providers/registry.ts';
import { getRepo } from '../../repo/index.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export const saveUpstreamForModels = async (
  previous: UpstreamRecord | null,
  next: UpstreamRecord,
): Promise<void> => {
  const upstreams = getRepo().upstreams;
  if (previous !== null && modelsFetchIdentity(previous) === modelsFetchIdentity(next)) {
    await upstreams.save(next);
  } else {
    await upstreams.saveClearingModelsCache(next);
  }
};
