import { prepareNativeFetch } from './replayable-body.ts';

// Indirection for outbound HTTP so per-upstream proxy chains can be
// threaded by reference.
export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export const directFetcher: Fetcher = async (url, init) => {
  const prepared = prepareNativeFetch(init);
  try {
    return await fetch(url, prepared.init);
  } catch (error) {
    let cleanupFailures: readonly unknown[];
    try {
      cleanupFailures = await prepared.cancel(error);
    } catch (cleanupError) {
      cleanupFailures = [cleanupError];
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Native fetch and request-body cleanup both failed',
        { cause: error },
      );
    }
    throw error;
  }
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
// its slot immediately keeps a large serialized body owned only by the fetcher,
// whose proxy path replaces it with replayable bytes.
export const dispatchUpstreamFetch = (
  options: Pick<UpstreamFetchOptions, 'fetcher' | 'wrapUpstreamCall'>,
  url: string,
  init: RequestInit,
): Promise<Response> => {
  let owned: RequestInit | undefined = init;
  const wrapped = options.wrapUpstreamCall(() => {
    if (owned === undefined) throw new Error('upstream fetch dispatch invoked more than once');
    const request = owned;
    owned = undefined;
    return options.fetcher(url, request);
  });
  return wrapped.then(response => {
    if (owned !== undefined) {
      owned = undefined;
      throw new Error('upstream fetch dispatch was not invoked');
    }
    return response;
  });
};
