const BACKOFF_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export const modelsRefreshRetryAt = (failedAt: number, previousFailureCount: number): number =>
  failedAt + BACKOFF_DELAYS_MS[Math.min(previousFailureCount, BACKOFF_DELAYS_MS.length - 1)];
