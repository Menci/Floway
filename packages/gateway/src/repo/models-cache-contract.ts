import type { UpstreamModelsCacheState } from './types.ts';

// Persisted ProviderModel rows contain code-derived metadata as well as the
// upstream response. Increment this whenever that derived catalog contract or
// its serialization changes so Cron refreshes older rows across deployments.
export const MODEL_CATALOG_REVISION = 31;

export const AUTOMATIC_REFRESH_INTERVAL_MS = 10 * 60_000;

export const isModelsCacheDue = (
  cache: UpstreamModelsCacheState,
  now: number,
  requiresNetwork: boolean,
): boolean => {
  if (cache.revision !== MODEL_CATALOG_REVISION || cache.fetchedAt === null) return true;
  if (!requiresNetwork) return false;
  return now - cache.fetchedAt >= AUTOMATIC_REFRESH_INTERVAL_MS;
};

export const MAX_STORED_MODEL_ERROR_LENGTH = 16_384;

export const storedModelErrorMessage = (message: string): string => message.length > MAX_STORED_MODEL_ERROR_LENGTH
  ? `${message.slice(0, MAX_STORED_MODEL_ERROR_LENGTH - 1)}…`
  : message;
