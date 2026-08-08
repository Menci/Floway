import { isReplayableBody } from '@floway-dev/http';
import type { Fetcher, FetchInit } from '@floway-dev/http';

export type { Fetcher, FetchInit, ReplayableBody } from '@floway-dev/http';
export { isReplayableBody } from '@floway-dev/http';

export const directFetcher: Fetcher = (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) return fetch(url, { ...init, body });
  return Promise.reject(new Error('Replayable request bodies require a runtime-composed direct fetcher'));
};

// extraHeaders are merged on top of the helper's own default headers.
export interface UpstreamFetchOptions {
  extraHeaders?: Headers;
  fetcher: Fetcher;
  /** See UpstreamCallOptions.wrapUpstreamCall — same contract. */
  wrapUpstreamCall: <T>(dispatch: () => Promise<T>) => Promise<T>;
}

// Identity wrapper for callers that don't participate in per-request TTFT
// timing — model-listing helpers and interceptor sub-calls that dispatch
// outside the primary data-plane fetch.
export const identityWrapUpstreamCall = <T>(dispatch: () => Promise<T>): Promise<T> => dispatch();

// Transfer a request into the fetcher exactly once. The wrapper used for
// upstream-call timing can outlive dispatch for the whole network wait; clearing
// its slot immediately leaves the fetcher as the request's only owner.
export const dispatchUpstreamFetch = (
  options: Pick<UpstreamFetchOptions, 'fetcher' | 'wrapUpstreamCall'>,
  url: string,
  init: FetchInit,
): Promise<Response> => {
  let owned: FetchInit | undefined = init;
  return options.wrapUpstreamCall(() => {
    if (owned === undefined) throw new Error('upstream fetch dispatch invoked more than once');
    const request = owned;
    owned = undefined;
    return options.fetcher(url, request);
  });
};
