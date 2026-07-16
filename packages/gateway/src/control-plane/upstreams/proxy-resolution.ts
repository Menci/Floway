import { createFetcher, type ProxyEntry } from '../../dial/fetcher.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_CONNECT_ID, isDirectFallbackId, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { getSocketDial } from '@floway-dev/platform';
import { directFetcher, type Fetcher, type ProxyFallbackEntry } from '@floway-dev/provider';
import { parseProxyUri, type ProxyUriError, runDirectConnectRequest, runProxiedRequest } from '@floway-dev/proxy';

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
  return directFetcher;
};

const buildOverrideFetcher = async (
  rawList: readonly ProxyFallbackEntry[],
  upstreamId: string,
  runtimeLocation: string,
): Promise<Fetcher> => {
  const list = normalizeProxyFallbackList(rawList);
  const referenced = new Set(list.filter(entry => !isDirectFallbackId(entry.id)).map(entry => entry.id));
  if (referenced.size === 0 && !list.some(entry => entry.id === DIRECT_CONNECT_ID)) {
    return directFetcher;
  }

  const repo = getRepo();
  const proxies = await repo.proxies.list();
  const proxyById = new Map<string, ProxyEntry>();
  const parseErrors = new Map<string, ProxyUriError>();
  for (const p of proxies) {
    if (!referenced.has(p.id)) continue;
    try {
      proxyById.set(p.id, {
        config: parseProxyUri(p.url),
        dialTimeoutMs: p.dialTimeoutSeconds === null ? null : p.dialTimeoutSeconds * 1000,
      });
    } catch (err) {
      parseErrors.set(p.id, err as ProxyUriError);
    }
  }

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
