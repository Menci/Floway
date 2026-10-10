import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';

export const runUpstreamScheduledTasks = async (runtimeLocation: string | null): Promise<void> => {
  const upstreams = await getRepo().upstreams.list();
  const failures: Error[] = [];
  await Promise.all(upstreams.map(async record => {
    try {
      await createProvider(record).instance.runScheduledTask({
        fetcher: async fresh => {
          if (runtimeLocation === null && !hasLocationIndependentEgress(fresh.proxyFallbackList)) return null;
          return (await createPerRequestFetcher(runtimeLocation, [fresh]))(fresh.id);
        },
      });
    } catch (cause) {
      failures.push(new Error(`Scheduled upstream task failed for ${record.id}`, { cause }));
    }
  }));
  if (failures.length > 0) throw new AggregateError(failures, 'Upstream scheduled tasks failed');
};
