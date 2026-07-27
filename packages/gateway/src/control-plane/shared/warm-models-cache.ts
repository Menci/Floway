import type { Context } from 'hono';

import { fetchUpstreamModelsCached } from '../../data-plane/providers/models-cache.ts';
import { createProvider } from '../../data-plane/providers/registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { logInfo } from '@floway-dev/provider-claude-code';

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Populate the SWR model cache synchronously after saving an upstream so the
// next dashboard read sees the new catalog. The cache layer persists upstream
// fetch failures in `lastError`; errors escaping that layer are internal and
// must remain observable without aborting the surrounding control-plane write.
export const warmModelsCache = async (record: UpstreamRecord, c: Context): Promise<void> => {
  const scheduler = backgroundSchedulerFromContext(c);
  const provider = createProvider(record);
  const fetcher = (await createPerRequestFetcher(getRuntimeLocation(c.req.raw)))(record.id);
  try {
    await fetchUpstreamModelsCached(provider, { scheduler, fetcher, force: true });
  } catch (error) {
    logInfo('warm_models_cache_failed', { upstream_id: record.id, error: errorMessage(error) });
  }
};
