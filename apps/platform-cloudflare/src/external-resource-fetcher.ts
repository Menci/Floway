import type { ExternalResourceFetcher } from '@floway-dev/platform';

export const createCloudflareExternalResourceFetcher = (
  fetchImpl: typeof fetch = fetch,
): ExternalResourceFetcher =>
  (url, signal) => fetchImpl(url, { redirect: 'manual', signal });
