import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import type { UpstreamModelEntry, UpstreamRepo } from '../../src/repo/types.ts';
import type { ProviderModel } from '@floway-dev/provider';

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  input: {
    readonly version: number;
    readonly revision?: number;
    readonly fetchedAt: number;
    readonly models: readonly (ProviderModel | UpstreamModelEntry)[];
  },
): Promise<boolean> => {
  const entries: UpstreamModelEntry[] = input.models.map(item =>
    'model' in item ? item : { source: 'auto', model: item });
  const committedVersion = await repo.publishModelsRefresh({
    id,
    version: input.version,
    revision: input.revision ?? MODEL_CATALOG_REVISION,
    fetchedAt: input.fetchedAt,
    models: entries,
  });
  return committedVersion !== null;
};

export const seedModelsCacheError = async (
  repo: UpstreamRepo,
  id: string,
  version: number,
  error: { readonly message: string; readonly at: number },
): Promise<boolean> => {
  return await repo.recordModelsRefreshFailure({ id, version, error });
};
