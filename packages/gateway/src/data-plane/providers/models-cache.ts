import { scheduleUpstreamModelsRefresh } from './models-refresh.ts';
import type { GatewayProvider } from './registry.ts';
import { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, ProviderModel, UpstreamModelsCache } from '@floway-dev/provider';

const SOFT_MS = 10 * 60 * 1000;

export { MODEL_CATALOG_REVISION } from '../../repo/models-cache-contract.ts';

export interface ModelsSnapshot {
  readonly models: readonly ProviderModel[];
  readonly lastError: UpstreamModelsCache['lastError'];
}

interface ModelsSnapshotReadOptions {
  scheduler: BackgroundScheduler;
  fetcher: Fetcher;
}

// Capture one immutable snapshot before scheduling any refresh work so its
// models and error metadata always describe the same durable generation.
export const readUpstreamModelsSnapshotAndScheduleRefresh = (
  instance: GatewayProvider,
  options: ModelsSnapshotReadOptions,
): ModelsSnapshot => {
  const { scheduler, fetcher } = options;
  const cached = instance.modelsCache?.revision === MODEL_CATALOG_REVISION ? instance.modelsCache : null;
  const snapshot = {
    models: cached?.models ?? [],
    lastError: cached?.lastError ?? null,
  };
  if (!cached || Date.now() - cached.fetchedAt >= SOFT_MS) {
    scheduleUpstreamModelsRefresh(instance, scheduler, fetcher);
  }
  return snapshot;
};
