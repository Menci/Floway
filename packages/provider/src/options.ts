// Indirection for outbound HTTP so per-upstream proxy chains can be
// threaded by reference.
export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export const directFetcher: Fetcher = (url, init) => fetch(url, init);

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
