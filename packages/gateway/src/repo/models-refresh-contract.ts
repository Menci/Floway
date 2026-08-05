export const MODELS_REFRESH_BACKOFF_BASE_MS = 60_000;
export const MODELS_REFRESH_BACKOFF_CAP_MS = 60 * 60_000;
export const MODELS_REFRESH_BACKOFF_EXPONENT_CAP = 6;
export const MODELS_REFRESH_CLAIM_LEASE_MS = 15 * 60_000;

export const modelsRefreshRetryAt = (now: number, previousFailureCount: number): number =>
  now + Math.min(
    MODELS_REFRESH_BACKOFF_BASE_MS * (2 ** Math.min(previousFailureCount, MODELS_REFRESH_BACKOFF_EXPONENT_CAP)),
    MODELS_REFRESH_BACKOFF_CAP_MS,
  );
