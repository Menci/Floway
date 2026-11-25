import type { GatewayProvider } from './registry.ts';
import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { MODEL_CATALOG_REVISION, shouldScheduleModelsRefresh } from '../../repo/models-cache-contract.ts';
import { modelsRefreshInputHash } from '../../repo/models-refresh-inputs.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import type { ProviderModel, UpstreamModelsCache } from '@floway-dev/provider';

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

export interface ModelsSnapshot {
  readonly models: readonly ProviderModel[];
  readonly lastError: UpstreamModelsCache['lastError'];
}

export type ModelCatalogSource = Pick<GatewayProvider,
  'upstreamId' | 'name' | 'modelsCache' | 'configVersion' | 'modelsRefreshInputHash' | 'modelPrefix' | 'disabledPublicModelIds'
>;

export const modelCatalogSource = (record: StoredUpstreamRecord): ModelCatalogSource => ({
  upstreamId: record.id,
  name: record.name,
  modelsCache: record.modelsCache,
  configVersion: record.configVersion,
  modelsRefreshInputHash: modelsRefreshInputHash(record),
  modelPrefix: record.modelPrefix,
  disabledPublicModelIds: record.disabledPublicModelIds,
});

// Capture one immutable snapshot before scheduling any refresh work so its
// models and error metadata always describe the same durable snapshot.
export const readUpstreamModelsSnapshotAndScheduleRefresh = (
  instance: ModelCatalogSource,
  scheduleRefresh: ModelsRefreshScheduler,
): ModelsSnapshot => {
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;
  const snapshot = {
    models: cached?.models ?? [],
    lastError: cached?.lastError ?? null,
  };
  if (shouldScheduleModelsRefresh(cached, Date.now())) {
    scheduleRefresh({
      upstreamId: instance.upstreamId,
      configVersion: instance.configVersion,
      inputHash: instance.modelsRefreshInputHash,
    });
  }
  return snapshot;
};
