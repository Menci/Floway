import type { Fetcher } from '@floway-dev/http';

let implementation: Fetcher | null = null;

export const initFetch = (fetcher: Fetcher): void => {
  implementation = fetcher;
};

export const getFetch = (): Fetcher => {
  if (implementation === null) throw new Error('Fetch not initialized — call initFetch() first');
  return implementation;
};
