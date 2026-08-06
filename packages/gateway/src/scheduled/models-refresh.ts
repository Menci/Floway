import { scheduleModelsRefreshExecution } from '../execution/models-refresh.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export const scheduleModelsCacheRefreshes = async (runtimeLocation: string | null, scheduler: BackgroundScheduler): Promise<void> => {
  const upstreams = (await getRepo().upstreams.list()).filter(upstream =>
    upstream.enabled && (runtimeLocation !== null || hasLocationIndependentEgress(upstream.proxyFallbackList)));
  for (const upstream of upstreams) {
    try {
      scheduleModelsRefreshExecution(upstream, runtimeLocation, scheduler);
    } catch (error) {
      console.error(`[scheduled] models.refresh failed for ${upstream.id}`, error);
    }
  }
};
