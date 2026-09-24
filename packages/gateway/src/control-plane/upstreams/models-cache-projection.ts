import type { ListedUpstreamModel, ModelsCacheStatus } from './types.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
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

export const cachedModelsForDashboard = (record: StoredUpstreamRecord): UpstreamModelConfig[] | null => {
  const cache = record.modelsCache;
  if (cache === null || cache.fetchedAt <= 0) return null;
  if (record.kind === 'custom') return cache.discovered ?? null;
  if (record.kind === 'azure') return [];
  return cache.models.map(reshapeModelForDashboard);
};

export const modelsCacheStatus = (record: StoredUpstreamRecord): ModelsCacheStatus => ({
  fetchedAt: record.modelsCache && record.modelsCache.fetchedAt > 0 ? record.modelsCache.fetchedAt : null,
  lastError: record.modelsCache?.lastError
    ? { message: record.modelsCache.lastError.message, at: record.modelsCache.lastError.at }
    : null,
  modelCount: record.modelsCache && record.modelsCache.fetchedAt > 0 ? storedCatalogSize(record) : null,
});
