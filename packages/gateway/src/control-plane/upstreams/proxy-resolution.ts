import { createDetachedFetcher, createPerRequestFetcher } from '../../dial/per-request.ts';
import type { Fetcher, ProxyFallbackEntry } from '@floway-dev/provider';

// Fetcher resolution for control-plane operations that fire from the
// dashboard edit form, where the in-progress proxy_fallback_list must take
// precedence over whatever is persisted. The override path validates proxy
// ids against the catalog and throws on unknown / malformed entries; the
// persisted path reuses the per-request fetcher bound to the saved row. An
// override is an unsaved policy even when the form edits a saved upstream, so
// its dials leave that upstream's proxy backoff state alone.
export const resolveControlPlaneFetcher = async (opts: {
  override?: readonly ProxyFallbackEntry[];
  upstreamId?: string;
  runtimeLocation: string;
}): Promise<Fetcher> => {
  if (opts.override !== undefined) return await createDetachedFetcher(opts.override, opts.runtimeLocation);
  if (opts.upstreamId !== undefined) {
    return (await createPerRequestFetcher(opts.runtimeLocation))(opts.upstreamId);
  }
  // Neither an in-progress edit nor a persisted row to read a policy from.
  // That is the same "no policy" state an empty list expresses, so route it
  // through the same builder instead of hard-coding a transport here.
  return await createDetachedFetcher([], opts.runtimeLocation);
};
