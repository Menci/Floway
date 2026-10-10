import { createProvider } from '../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';

export const runUpstreamScheduledTasks = async (runtimeLocation: string | null): Promise<void> => {
  const repo = getRepo();
  const upstreams = await repo.upstreams.list();
  const failures: Error[] = [];
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < upstreams.length) {
      const record = upstreams[cursor++]!;
      if (!record.enabled || (runtimeLocation === null && !hasLocationIndependentEgress(record.proxyFallbackList))) continue;
      try {
        await createProvider(record).instance.runScheduledTask({
          tasks: repo.upstreamScheduledTasks,
          fetcher: async fresh => {
            if (runtimeLocation === null && !hasLocationIndependentEgress(fresh.proxyFallbackList)) return null;
            return (await createPerRequestFetcher(runtimeLocation, [fresh]))(fresh.id);
          },
        });
      } catch (cause) {
        failures.push(new Error(`Scheduled upstream task failed for ${record.id}`, { cause }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, upstreams.length) }, runNext));
  if (failures.length > 0) throw new AggregateError(failures, 'Upstream scheduled tasks failed');
};
