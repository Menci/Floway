import { createModelsRefreshScheduler, modelsRefreshTarget } from '../execution/models-refresh.ts';
import { getRepo } from '../repo/index.ts';
import { shouldScheduleModelsRefresh } from '../repo/models-cache-contract.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export const scheduleModelsCacheRefreshes = async (runtimeLocation: string | null, scheduler: BackgroundScheduler): Promise<void> => {
  const scheduleRefresh = createModelsRefreshScheduler(runtimeLocation, scheduler);
  const upstreams = await getRepo().upstreams.list();
  const now = Date.now();
  for (const upstream of upstreams) {
    if (!upstream.enabled
      || (runtimeLocation === null && !hasLocationIndependentEgress(upstream.proxyFallbackList))
      || !shouldScheduleModelsRefresh(upstream.modelsCache, now)) continue;
    scheduleRefresh(modelsRefreshTarget(upstream));
  }
};
