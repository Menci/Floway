import { createModelsRefreshScheduler, modelsRefreshTarget } from '../execution/models-refresh.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export const scheduleModelsCacheRefreshes = async (runtimeLocation: string | null, scheduler: BackgroundScheduler): Promise<void> => {
  const scheduleRefresh = createModelsRefreshScheduler(runtimeLocation, scheduler);
  const upstreams = (await getRepo().upstreams.list()).filter(upstream =>
    upstream.enabled && (runtimeLocation !== null || hasLocationIndependentEgress(upstream.proxyFallbackList)));
  for (const upstream of upstreams) {
    try {
      scheduleRefresh(modelsRefreshTarget(upstream));
    } catch (error) {
      console.error(`[scheduled] models.refresh failed for ${upstream.id}`, error);
    }
  }
};
