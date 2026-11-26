import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import type { UpstreamRepo } from '../../src/repo/types.ts';
import type { ProviderModel } from '@floway-dev/provider';

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  input: {
    readonly version: number;
    readonly revision?: number;
    readonly fetchedAt: number;
    readonly models: readonly ProviderModel[];
  },
): Promise<boolean> => {
  const committedVersion = await repo.publishModelsRefresh({
    id,
    version: input.version,
    revision: input.revision ?? MODEL_CATALOG_REVISION,
    fetchedAt: input.fetchedAt,
    models: input.models.map(model => ({ source: 'auto', model })),
  });
  return committedVersion !== null;
};
