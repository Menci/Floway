const BACKOFF_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export const modelsRefreshRetryAt = (error: { at: number; failureCount: number }): number =>
  error.at + BACKOFF_DELAYS_MS[Math.min(error.failureCount - 1, BACKOFF_DELAYS_MS.length - 1)];
