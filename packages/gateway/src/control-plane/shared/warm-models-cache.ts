import type { Context } from 'hono';

import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { UpstreamModelsCache, UpstreamRecord } from '@floway-dev/provider';
import { logInfo } from '@floway-dev/provider-claude-code';

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Populate the SWR model cache synchronously after saving an upstream so the
// next dashboard read sees the new catalog. The cache layer persists upstream
// fetch failures in `lastError`; errors escaping that layer are internal and
// must remain observable without aborting the surrounding control-plane write.
//
// Returns what the row holds afterwards so the caller can answer with the
// freshness this warm produced rather than the snapshot it read before saving.
// Null when the upstream fetch failed and left the row with nothing to report.
export const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<UpstreamModelsCache | null> => {
  const scheduler = backgroundSchedulerFromContext(c);
  const provider = createProvider(record);
  const fetcher = (await createPerRequestFetcher(getRuntimeLocation(c.req.raw)))(record.id);
  try {
    await fetchUpstreamModelsCached(provider, { scheduler, fetcher, force: true });
  } catch (error) {
    logInfo('warm_models_cache_failed', { upstream_id: record.id, error: errorMessage(error) });
  }
  // Read back rather than reconstructing: on the failure path the row keeps
  // whatever catalog it already had, annotated with this attempt's error.
  return (await getRepo().upstreams.getById(record.id))?.modelsCache ?? null;
};
