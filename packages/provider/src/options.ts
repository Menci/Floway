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
}
