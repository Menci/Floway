import { scheduleUpstreamModelsRefresh } from '../data-plane/providers/models-refresh.ts';
import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export const scheduleModelsCacheRefreshes = async (runtimeLocation: string | null, scheduler: BackgroundScheduler): Promise<void> => {
  const upstreams = (await getRepo().upstreams.list()).filter(upstream =>
    upstream.enabled && (runtimeLocation !== null || hasLocationIndependentEgress(upstream.proxyFallbackList)));
  const fetcherForUpstream = await createPerRequestFetcher(runtimeLocation, upstreams);

  for (const upstream of upstreams) {
    try {
      scheduleUpstreamModelsRefresh(createProvider(upstream), scheduler, fetcherForUpstream(upstream.id));
    } catch (error) {
      console.error(`[scheduled] models.refresh failed for ${upstream.id}`, error);
    }
  }
};
