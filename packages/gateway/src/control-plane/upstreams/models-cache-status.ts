import type { ModelsCacheStatus } from './types.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';

export const modelsCacheStatus = (record: StoredUpstreamRecord): ModelsCacheStatus => ({
  fetchedAt: record.modelsCache?.fetchedAt ?? null,
  lastError: record.modelsCache?.lastError ?? null,
  modelCount: storedCatalogSize(record),
});
