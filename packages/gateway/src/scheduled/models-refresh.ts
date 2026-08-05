import { fetchUpstreamModelsCached } from '../data-plane/providers/models-cache.ts';
import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';

export const refreshModelsCaches = async (runtimeLocation: string): Promise<void> => {
  const upstreams = (await getRepo().upstreams.list()).filter(upstream => upstream.enabled);
  const fetcherForUpstream = await createPerRequestFetcher(runtimeLocation, upstreams);
  const pending: Promise<unknown>[] = [];

  for (const upstream of upstreams) {
    await fetchUpstreamModelsCached(createProvider(upstream), {
      scheduler: promise => { pending.push(promise); },
      fetcher: fetcherForUpstream(upstream.id),
    });
  }

  const settled = await Promise.allSettled(pending);
  const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} model cache refreshes failed`);
};
