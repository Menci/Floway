import type { ListedUpstreamModel, ModelsCacheStatus } from './types.ts';
import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import type { ProviderModel, UpstreamModelConfig } from '@floway-dev/provider';

export const reshapeModelForDashboard = (model: ProviderModel): ListedUpstreamModel => ({
  upstreamModelId: model.upstreamModelId,
  publicModelId: model.id,
  kind: model.kind,
  endpoints: model.endpoints,
  ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
  ...(Object.keys(model.limits).length > 0 ? { limits: model.limits } : {}),
  ...(model.pricing ? { pricing: model.pricing } : {}),
  ...(model.chat ? { chat: model.chat } : {}),
  opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope,
  ...(model.flagOverrides ? { flagOverrides: model.flagOverrides } : {}),
});

export const loadCachedModelsForDashboard = async (record: StoredUpstreamRecord): Promise<UpstreamModelConfig[] | null> => {
  if (record.modelsCache.fetchedAt === null) return null;
  if (record.kind === 'azure') return [];
  const rows = await getRepo().upstreamModels.listByUpstream(record.id, { source: 'auto' });
  return rows.map(({ model }) => reshapeModelForDashboard(model));
};

export const modelsCacheStatus = (
  record: StoredUpstreamRecord,
  modelCount: number | null,
): ModelsCacheStatus => ({
  fetchedAt: record.modelsCache.fetchedAt,
  lastError: record.modelsCache.lastError
    ? { message: record.modelsCache.lastError.message, at: record.modelsCache.lastError.at }
    : null,
  modelCount: record.modelsCache.fetchedAt !== null ? modelCount : null,
});
