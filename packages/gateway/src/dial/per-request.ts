import { createFetcher } from './fetcher.ts';
import { loadProxyCatalog } from './proxy-catalog.ts';
import { getRepo } from '../repo/index.ts';
import { entryMatchesColo, isDirectFallbackId } from '../repo/proxy-fallback-list.ts';
import { getSocketDial } from '@floway-dev/platform';
import { directFetcher, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { runDirectConnectRequest, runProxiedRequest } from '@floway-dev/proxy';

export class InvalidProxyConfigurationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InvalidProxyConfigurationError';
  }
}

// Parse failures on individual proxy rows are isolated to the upstreams that
// actually request their fetcher: a single malformed URL does not take down
// every other upstream in the same request.
//
// `preFetchedUpstreams` lets a caller reuse a list it already loaded on
// this request instead of paying a second `upstreams.list()` round-trip.
const createFetcherResolver = async (
  runtimeLocation: string | null,
  preFetchedUpstreams: readonly UpstreamRecord[] | undefined,
  validation: 'lazy' | 'eager',
): Promise<(upstreamId: string) => Fetcher> => {
  const repo = getRepo();
  const upstreams = preFetchedUpstreams ?? await repo.upstreams.list();
  const configuredById = new Map(upstreams.map(u => [u.id, u.proxyFallbackList] as const));
  const fallbackById = new Map(upstreams.map(u => [
    u.id,
    u.proxyFallbackList.filter(entry => entryMatchesColo(entry, runtimeLocation)),
  ] as const));

  const referencedProxyIds = new Set<string>();
  const catalogLists = validation === 'eager' ? configuredById.values() : fallbackById.values();
  for (const list of catalogLists) {
    for (const entry of list) {
      if (!isDirectFallbackId(entry.id)) referencedProxyIds.add(entry.id);
    }
  }

  const { proxyById, parseErrors: proxyParseErrors } = await loadProxyCatalog(repo, referencedProxyIds);

  return upstreamId => {
    // Fail loud on an unknown upstream id. Silently substituting `[]`
    // would route the request through direct-fetch only, masking a stale
    // api-key→upstream binding or a typo in the caller as a working
    // proxy-bypass.
    const list = fallbackById.get(upstreamId);
    if (list === undefined) {
      throw new Error(`unknown upstream id requested from per-request fetcher: ${upstreamId}`);
    }
    const validationList = validation === 'eager' ? configuredById.get(upstreamId)! : list;
    const bad = validationList.find(entry => proxyParseErrors.has(entry.id));
    if (bad !== undefined) {
      const first = bad.id;
      const err = proxyParseErrors.get(first)!;
      if (validation === 'eager') throw new InvalidProxyConfigurationError(`upstream ${upstreamId} references malformed proxy ${first}: ${err.message}`, err);
      return async () => { throw new Error(`upstream ${upstreamId} references malformed proxy ${first}: ${err.message}`); };
    }
    const unknown = validationList.find(entry => !isDirectFallbackId(entry.id) && !proxyById.has(entry.id));
    if (validation === 'eager' && unknown !== undefined) throw new InvalidProxyConfigurationError(`unknown proxy id in fallback list: ${unknown.id}`);
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
};

export const createPerRequestFetcher = (
  runtimeLocation: string | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<(upstreamId: string) => Fetcher> => createFetcherResolver(runtimeLocation, preFetchedUpstreams, 'lazy');

export const createValidatedPerRequestFetcher = (
  runtimeLocation: string | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<(upstreamId: string) => Fetcher> => createFetcherResolver(runtimeLocation, preFetchedUpstreams, 'eager');

export const validateUpstreamProxyConfiguration = async (
  runtimeLocation: string | null,
  upstream: UpstreamRecord,
): Promise<void> => {
  (await createValidatedPerRequestFetcher(runtimeLocation, [upstream]))(upstream.id);
};
