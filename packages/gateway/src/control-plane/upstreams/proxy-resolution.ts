import { createFetcher } from '../../dial/fetcher.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { loadProxyCatalog } from '../../dial/proxy-catalog.ts';
import { getRepo } from '../../repo/index.ts';
import { isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { getSocketDial } from '@floway-dev/platform';
import { directFetcher, type Fetcher, type ProxyFallbackEntry } from '@floway-dev/provider';
import { runDirectConnectRequest, runProxiedRequest } from '@floway-dev/proxy';

// Fetcher resolution for control-plane operations that fire from the
// dashboard edit form, where the in-progress proxy_fallback_list must take
// precedence over whatever is persisted. The override path validates proxy
// ids against the catalog and throws on unknown / malformed entries; the
// persisted path reuses the per-request fetcher bound to the saved row.
export const resolveControlPlaneFetcher = async (opts: {
  override?: readonly ProxyFallbackEntry[];
  upstreamId?: string;
  runtimeLocation: string;
}): Promise<Fetcher> => {
  if (opts.override !== undefined) {
    return await buildOverrideFetcher(opts.override, opts.upstreamId ?? 'draft', opts.runtimeLocation);
  }
  if (opts.upstreamId !== undefined) {
    return (await createPerRequestFetcher(opts.runtimeLocation))(opts.upstreamId);
  }
  // Neither an in-progress edit nor a persisted row to read a policy from.
  // That is the same "no policy" state an empty list expresses, so route it
  // through the same builder instead of hard-coding a transport here.
  return await buildOverrideFetcher([], 'draft', opts.runtimeLocation);
};

const buildOverrideFetcher = async (
  rawList: readonly ProxyFallbackEntry[],
  upstreamId: string,
  runtimeLocation: string,
): Promise<Fetcher> => {
  const list = normalizeProxyFallbackList(rawList);
  const referenced = new Set(list.filter(entry => !isDirectFallbackId(entry.id)).map(entry => entry.id));

  const repo = getRepo();
  const { proxyById, parseErrors } = await loadProxyCatalog(repo, referenced);

  const unknown = list.find(entry => !isDirectFallbackId(entry.id) && !proxyById.has(entry.id) && !parseErrors.has(entry.id));
  if (unknown !== undefined) {
    throw new Error(`unknown proxy id in fallback list: ${unknown.id}`);
  }
  const bad = list.find(entry => parseErrors.has(entry.id));
  if (bad !== undefined) {
    const err = parseErrors.get(bad.id)!;
    throw new Error(`malformed proxy ${bad.id}: ${err.message}`);
  }

  return createFetcher({
    repo,
    upstreamId,
    fallbackList: list,
    runtimeLocation,
    proxyById,
    runProxied: runProxiedRequest,
    runDirectFetch: directFetcher,
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
  });
};
