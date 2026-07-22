import type { ApiKey } from './types.ts';

export const RESPONSES_RETENTION_MIN_SECONDS = 60 * 60;
export const RESPONSES_RETENTION_MAX_SECONDS = 10 * 365 * 24 * 60 * 60;

export const generateResponsesStateEpoch = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const responsesStateLifetime = (
  refreshedAt: number,
  retentionSeconds: number,
): { refreshedAt: number; expiresAt: number } => {
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < RESPONSES_RETENTION_MIN_SECONDS || retentionSeconds > RESPONSES_RETENTION_MAX_SECONDS) {
    throw new RangeError(`Responses retention must be an integer from ${RESPONSES_RETENTION_MIN_SECONDS} to ${RESPONSES_RETENTION_MAX_SECONDS} seconds`);
  }
  return { refreshedAt, expiresAt: refreshedAt + retentionSeconds * 1000 };
};

export const withResponsesRetention = (apiKey: ApiKey, responsesRetentionSeconds: number): ApiKey => {
  if (responsesRetentionSeconds === apiKey.responsesRetentionSeconds) return apiKey;
  return {
    ...apiKey,
    responsesRetentionSeconds,
    ...(responsesRetentionSeconds < apiKey.responsesRetentionSeconds
      ? { responsesStateEpoch: generateResponsesStateEpoch() }
      : {}),
  };
};
