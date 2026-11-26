import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import type { UpstreamModelEntry, UpstreamRepo } from '../../src/repo/types.ts';
import type { ProviderModel, UpstreamModelConfig } from '@floway-dev/provider';

export const seedModelsCache = async (
  repo: UpstreamRepo,
  id: string,
  input: {
    readonly configVersion: number;
    readonly revision?: number;
    readonly fetchedAt: number;
    readonly models: readonly (ProviderModel | UpstreamModelEntry)[];
    readonly discovered?: readonly UpstreamModelConfig[] | null;
  },
): Promise<boolean> => {
  const entries: UpstreamModelEntry[] = input.models.map(item =>
    'model' in item ? item : { source: 'auto', model: item });
  return await repo.publishModelsRefresh({
    id,
    configVersion: input.configVersion,
    revision: input.revision ?? MODEL_CATALOG_REVISION,
    fetchedAt: input.fetchedAt,
    models: entries,
    ...(input.discovered !== undefined ? { discovered: input.discovered } : {}),
  });
};

export const seedModelsCacheError = async (
  repo: UpstreamRepo,
  id: string,
  configVersion: number,
  error: { readonly message: string; readonly at: number },
): Promise<boolean> => {
  return await repo.recordModelsRefreshFailure({ id, configVersion, error });
};
