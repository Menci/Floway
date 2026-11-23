import { isReplayableBody } from '@floway-dev/http';
import type { Fetcher, HttpHeaderLines } from '@floway-dev/http';

export type { Fetcher, FetchInit, HttpHeaderLines, ReplayableBody } from '@floway-dev/http';
export { isReplayableBody } from '@floway-dev/http';

export const directFetcher: Fetcher = (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) return fetch(url, { ...init, body });
  return Promise.reject(new Error('Replayable request bodies require a runtime-composed direct fetcher'));
};

// extraHeaders are merged on top of the helper's own default headers. They
// are field lines rather than a `Headers` so a caller can send one name
// several times — see HttpHeaderLines.
export interface UpstreamFetchOptions {
  extraHeaders?: HttpHeaderLines;
  fetcher: Fetcher;
}
