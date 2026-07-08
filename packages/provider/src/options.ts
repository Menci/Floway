// Indirection for outbound HTTP so per-upstream proxy chains can be
// threaded by reference.
export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

// Plain runtime fetch as a Fetcher, for callers that need neither proxy
// nor recorder wrapping.
export const directFetcher: Fetcher = (url, init) => fetch(url, init);

// Per-call options for upstream fetch helpers: a per-upstream Fetcher plus
// optional headers merged on top of the helper's own default headers.
export interface UpstreamFetchOptions {
  extraHeaders?: Headers;
  fetcher: Fetcher;
}
