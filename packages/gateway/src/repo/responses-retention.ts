import type { ApiKey } from './types.ts';

export const RESPONSES_RETENTION_MIN_SECONDS = 60 * 60;
export const RESPONSES_RETENTION_MAX_SECONDS = 10 * 365 * 24 * 60 * 60;

export const generateResponsesStateEpoch = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const responsesStateCutoff = (
  activeAt: number,
  retentionSeconds: number,
  visibleAfter: number,
): number => {
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < RESPONSES_RETENTION_MIN_SECONDS || retentionSeconds > RESPONSES_RETENTION_MAX_SECONDS) {
    throw new RangeError(`Responses retention must be an integer from ${RESPONSES_RETENTION_MIN_SECONDS} to ${RESPONSES_RETENTION_MAX_SECONDS} seconds`);
  }
  if (!Number.isSafeInteger(visibleAfter) || visibleAfter < 0) throw new RangeError('Responses state visibility floor must be a non-negative safe integer');
  return Math.max(activeAt - retentionSeconds * 1000, visibleAfter);
};

export const withResponsesRetention = (apiKey: ApiKey, responsesRetentionSeconds: number, changedAt: number = Date.now()): ApiKey => {
  if (responsesRetentionSeconds === apiKey.responsesRetentionSeconds) return apiKey;
  if (responsesRetentionSeconds !== 0
    && (!Number.isSafeInteger(responsesRetentionSeconds)
      || responsesRetentionSeconds < RESPONSES_RETENTION_MIN_SECONDS
      || responsesRetentionSeconds > RESPONSES_RETENTION_MAX_SECONDS)) {
    throw new RangeError(`Responses retention must be 0 or an integer from ${RESPONSES_RETENTION_MIN_SECONDS} to ${RESPONSES_RETENTION_MAX_SECONDS} seconds`);
  }
  const disabling = responsesRetentionSeconds === 0 && apiKey.responsesRetentionSeconds > 0;
  const changingPositiveWindow = responsesRetentionSeconds > 0 && apiKey.responsesRetentionSeconds > 0;
  return {
    ...apiKey,
    responsesRetentionSeconds,
    ...(disabling
      ? { responsesStateEpoch: generateResponsesStateEpoch(), responsesStateVisibleAfter: 0 }
      : changingPositiveWindow
        ? { responsesStateVisibleAfter: Math.max(
            apiKey.responsesStateVisibleAfter,
            changedAt - Math.min(apiKey.responsesRetentionSeconds, responsesRetentionSeconds) * 1000,
          ) }
        : {}),
  };
};
