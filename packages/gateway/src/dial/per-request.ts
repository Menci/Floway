import { createFetcher, createProviderFetcher } from './fetcher.ts';
import { loadProxyCatalog } from './proxy-catalog.ts';
import { getRepo } from '../repo/index.ts';
import { entryMatchesColo, isDirectFallbackId, normalizeProxyFallbackList } from '../repo/proxy-fallback-list.ts';
import type { FetchInit, ProviderFetcher } from '@floway-dev/http';
import { getFetch, getHttpContentDecoders, getProviderFetch, getSocketDial } from '@floway-dev/platform';
import type { Fetcher, ProxyFallbackEntry, UpstreamRecord } from '@floway-dev/provider';
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
type RequestFetcherOptions = Omit<Parameters<typeof createFetcher>[0], 'runDirectFetch'>;
type FetchOperation<Response> = (url: string, init: FetchInit) => Promise<Response>;

const createFetcherResolver = async <Response>(
  runtimeLocation: string | null,
  preFetchedUpstreams: readonly UpstreamRecord[] | undefined,
  validation: 'lazy' | 'eager',
  create: (input: RequestFetcherOptions) => FetchOperation<Response>,
): Promise<(upstreamId: string) => FetchOperation<Response>> => {
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
    return create({
      repo,
      upstreamId,
      fallbackList: configuredById.get(upstreamId)!,
      runtimeLocation,
      proxyById,
      runProxied: runProxiedRequest,
      runDirectConnect: runDirectConnectRequest,
      socketDial: getSocketDial,
      contentDecoders: getHttpContentDecoders,
    });
  };
};

const createRuntimeFetcher = (input: RequestFetcherOptions): Fetcher => createFetcher({ ...input, runDirectFetch: getFetch() });

export const createPerRequestFetcher = (
  runtimeLocation: string | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<(upstreamId: string) => Fetcher> => createFetcherResolver(runtimeLocation, preFetchedUpstreams, 'lazy', createRuntimeFetcher);

export const createValidatedPerRequestFetcher = (
  runtimeLocation: string | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<(upstreamId: string) => Fetcher> => createFetcherResolver(runtimeLocation, preFetchedUpstreams, 'eager', createRuntimeFetcher);

export const createPerRequestProviderFetcher = (
  runtimeLocation: string | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<(upstreamId: string) => ProviderFetcher> => createFetcherResolver(runtimeLocation, preFetchedUpstreams, 'lazy',
  input => createProviderFetcher({ ...input, runDirectFetch: getProviderFetch() }));

// A fallback policy that no saved upstream owns, such as an edit form's
// in-progress list. Every referenced proxy must resolve before any dial, and
// the fetcher keeps no backoff state because there is no persisted
// (proxy, upstream) pair to attach it to.
export const createDetachedFetcher = async (
  rawList: readonly ProxyFallbackEntry[],
  runtimeLocation: string | null,
): Promise<Fetcher> => {
  const list = normalizeProxyFallbackList(rawList);
  const referenced = new Set(list.filter(entry => !isDirectFallbackId(entry.id)).map(entry => entry.id));
  const repo = getRepo();
  const { proxyById, parseErrors } = await loadProxyCatalog(repo, referenced);

  for (const id of referenced) {
    const err = parseErrors.get(id);
    if (err !== undefined) throw new InvalidProxyConfigurationError(`malformed proxy ${id}: ${err.message}`, err);
    if (!proxyById.has(id)) throw new InvalidProxyConfigurationError(`unknown proxy id in fallback list: ${id}`);
  }

  return createFetcher({
    repo,
    upstreamId: null,
    fallbackList: list,
    runtimeLocation,
    proxyById,
    runProxied: runProxiedRequest,
    runDirectFetch: getFetch(),
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
    contentDecoders: getHttpContentDecoders,
  });
};
