import type { ModelsCacheStatus } from './types.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';

export const modelsCacheStatus = (record: StoredUpstreamRecord): ModelsCacheStatus => ({
  fetchedAt: record.modelsCache && record.modelsCache.fetchedAt > 0 ? record.modelsCache.fetchedAt : null,
  lastError: record.modelsCache?.lastError
    ? { message: record.modelsCache.lastError.message, at: record.modelsCache.lastError.at }
    : null,
  modelCount: record.modelsCache && record.modelsCache.fetchedAt > 0 ? storedCatalogSize(record) : null,
});
