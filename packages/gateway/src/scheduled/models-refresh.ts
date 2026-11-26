import { refreshModels } from '../execution/models-refresh.ts';
import { getRepo } from '../repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../repo/models-cache-contract.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export const scheduleModelsCacheRefreshes = async (runtimeLocation: string | null, scheduler: BackgroundScheduler): Promise<void> => {
  const candidates = await getRepo().upstreams.listDueModelsRefresh(MODEL_CATALOG_REVISION, Date.now());
  for (const candidate of candidates) {
    if (candidate.requiresNetwork && runtimeLocation === null && !hasLocationIndependentEgress(candidate.proxyFallbackList)) {
      continue;
    }
    scheduler(refreshModels({ upstreamId: candidate.id, configVersion: candidate.configVersion }, runtimeLocation));
  }
};
