import type { Fetcher, HttpContentDecoders, ProviderFetcher } from '@floway-dev/http';

export type { HttpContentDecoders } from '@floway-dev/http';

let implementation: Fetcher | null = null;
let providerImplementation: ProviderFetcher | undefined;
let contentDecoders: HttpContentDecoders = new Map();

// Runtime fetch decodes its own responses. Socket HTTP needs the runtime's
// additional codecs explicitly because Web DecompressionStream is less capable.
export const initFetch = (fetcher: Fetcher, decoders: HttpContentDecoders = new Map(), providerFetcher?: ProviderFetcher): void => {
  implementation = fetcher;
  providerImplementation = providerFetcher;
  contentDecoders = decoders;
};

export const getProviderFetch = (): ProviderFetcher => {
  if (providerImplementation === undefined) throw new Error('Provider fetch not initialized — supply it to initFetch()');
  return providerImplementation;
};

export const getFetch = (): Fetcher => {
  if (implementation === null) throw new Error('Fetch not initialized — call initFetch() first');
  return implementation;
};

export const getHttpContentDecoders = (): HttpContentDecoders => {
  if (implementation === null) throw new Error('Fetch not initialized — call initFetch() first');
  return contentDecoders;
};
