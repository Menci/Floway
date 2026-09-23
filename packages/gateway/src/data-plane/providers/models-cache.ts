import type { GatewayProvider } from './registry.ts';
import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { MODEL_CATALOG_REVISION, shouldScheduleModelsRefresh } from '../../repo/models-cache-contract.ts';
import type { ProviderModel, UpstreamModelsCache } from '@floway-dev/provider';

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

export interface ModelsSnapshot {
  readonly models: readonly ProviderModel[];
  readonly lastError: UpstreamModelsCache['lastError'];
}

// Capture one immutable snapshot before scheduling any refresh work so its
// models and error metadata always describe the same durable snapshot.
export const readUpstreamModelsSnapshotAndScheduleRefresh = (
  instance: GatewayProvider,
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
