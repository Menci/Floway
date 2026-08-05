import { fetchUpstreamModelsCached } from '../data-plane/providers/models-cache.ts';
import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export const refreshModelsCaches = async (runtimeLocation: string, scheduler: BackgroundScheduler): Promise<void> => {
  const upstreams = (await getRepo().upstreams.list()).filter(upstream => upstream.enabled);
  const fetcherForUpstream = await createPerRequestFetcher(runtimeLocation, upstreams);

  for (const upstream of upstreams) {
    await fetchUpstreamModelsCached(createProvider(upstream), {
      scheduler,
      fetcher: fetcherForUpstream(upstream.id),
    });
  }
};
