import type { UpstreamModelsCache } from '@floway-dev/provider';

// Persisted ProviderModel rows contain code-derived metadata as well as the
// upstream response. Increment this whenever that derived catalog contract or
// its serialization changes so older rows become cold across deployments.
export const MODEL_CATALOG_REVISION = 12;

const AUTOMATIC_REFRESH_INTERVAL_MS = 10 * 60_000;

// Successful publication starts the interval; a failed attempt retains
// fetchedAt and is governed by the separate lastError backoff once due.
export const shouldScheduleModelsRefresh = (cache: UpstreamModelsCache | null, now: number): boolean =>
  cache?.revision !== MODEL_CATALOG_REVISION || now - cache.fetchedAt >= AUTOMATIC_REFRESH_INTERVAL_MS;

export const MAX_STORED_MODEL_ERROR_LENGTH = 16_384;

export const storedModelErrorMessage = (message: string): string => message.length > MAX_STORED_MODEL_ERROR_LENGTH
  ? `${message.slice(0, MAX_STORED_MODEL_ERROR_LENGTH - 1)}…`
  : message;
