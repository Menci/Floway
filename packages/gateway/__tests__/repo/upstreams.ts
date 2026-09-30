import type { UpstreamRepo } from '../../src/repo/types.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

export const saveUpstreamForTest = async (repo: UpstreamRepo, upstream: UpstreamRecord): Promise<void> => {
  const previous = await repo.getById(upstream.id);
  const saved = previous === null
    ? await repo.insertForModels(upstream)
    : await repo.replaceForModels({ previous, upstream });
  if (saved === null) throw new Error(`Failed to save test upstream ${upstream.id}`);
};
