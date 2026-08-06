import type { GatewayProvider } from './registry.ts';
import { scheduleModelsRefresh } from '../../execution/models-refresh.ts';
import { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProviderModel, UpstreamModelsCache } from '@floway-dev/provider';

const SOFT_MS = 10 * 60 * 1000;

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

export interface ModelsSnapshot {
  readonly models: readonly ProviderModel[];
  readonly lastError: UpstreamModelsCache['lastError'];
}

interface ModelsSnapshotReadOptions {
  scheduler: BackgroundScheduler;
  runtimeLocation: string;
}

// Capture one immutable snapshot before scheduling any refresh work so its
// models and error metadata always describe the same durable generation.
export const readUpstreamModelsSnapshotAndScheduleRefresh = (
  instance: GatewayProvider,
  options: ModelsSnapshotReadOptions,
): ModelsSnapshot => {
  const { scheduler, runtimeLocation } = options;
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;
  const snapshot = {
    models: cached?.models ?? [],
    lastError: cached?.lastError ?? null,
  };
  if (!cached || Date.now() - cached.fetchedAt >= SOFT_MS) {
    const fetchedAt = instance.modelsCache?.fetchedAt;
    scheduleModelsRefresh({
      upstreamId: instance.upstreamId,
      configVersion: instance.modelsCacheGeneration.configVersion,
      cacheEpoch: fetchedAt === undefined || fetchedAt === 0 ? null : fetchedAt,
    }, runtimeLocation, scheduler);
  }
  return snapshot;
};
