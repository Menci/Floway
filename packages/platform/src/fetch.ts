import type { Fetcher, HttpContentDecoders } from '@floway-dev/http';

export type { HttpContentDecoders } from '@floway-dev/http';

let implementation: Fetcher | null = null;
let contentDecoders: HttpContentDecoders = new Map();

// Runtime fetch decodes its own responses. Socket HTTP needs the runtime's
// additional codecs explicitly because Web DecompressionStream is less capable.
export const initFetch = (fetcher: Fetcher, decoders: HttpContentDecoders = new Map()): void => {
  implementation = fetcher;
  contentDecoders = decoders;
};

export const getFetch = (): Fetcher => {
  if (implementation === null) throw new Error('Fetch not initialized — call initFetch() first');
  return implementation;
};

export const getHttpContentDecoders = (): HttpContentDecoders => {
  if (implementation === null) throw new Error('Fetch not initialized — call initFetch() first');
  return contentDecoders;
};
