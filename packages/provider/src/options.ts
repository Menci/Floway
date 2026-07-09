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
  /** Per-provider fetch helper wraps its `fetcher(...)` promise with this to
   *  anchor TTFT to the actual outbound dispatch. Mirrors UpstreamCallOptions'
   *  contract — stamps `perfTiming.upstreamCallStartedAt` on invocation and
   *  returns the promise. */
  wrapUpstreamCall: <T>(promise: Promise<T>) => Promise<T>;
}
