import type { Fetcher } from '@floway-dev/http';

let implementation: Fetcher | null = null;

export const initRuntimeDirectFetch = (directFetch: Fetcher): void => {
  implementation = directFetch;
};

export const getRuntimeDirectFetch = (): Fetcher => {
  if (implementation === null) throw new Error('Runtime direct fetch not initialized — call initRuntimeDirectFetch() first');
  return implementation;
};
