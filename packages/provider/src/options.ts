import { isReplayableBody, toRequestInit } from '@floway-dev/http';
import type { Fetcher } from '@floway-dev/http';

export type { Fetcher, FetchInit, HttpHeaderLines, ReplayableBody } from '@floway-dev/http';
export { isReplayableBody, toRequestInit } from '@floway-dev/http';

export const directFetcher: Fetcher = (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) return fetch(url, toRequestInit(init, body));
  return Promise.reject(new Error('Replayable request bodies require a runtime-composed direct fetcher'));
};
