import { MILLISECONDS_PER_DAY, RETENTION_MAX_SECONDS, SECONDS_PER_DAY } from '../shared/retention.ts';

export const RESPONSES_REFRESH_GRANULARITY_MS = MILLISECONDS_PER_DAY;
export const RESPONSES_RETENTION_MIN_SECONDS = SECONDS_PER_DAY;
export const RESPONSES_RETENTION_MAX_SECONDS = RETENTION_MAX_SECONDS;

export const isResponsesRetentionSeconds = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && (
    value === 0
    || (
      value >= RESPONSES_RETENTION_MIN_SECONDS
      && value <= RESPONSES_RETENTION_MAX_SECONDS
      && value % SECONDS_PER_DAY === 0
    )
  );

export const quantizeResponsesRefreshedAt = (timestamp: number): number => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError('Responses refresh timestamp must be a non-negative safe integer');
  }
  return timestamp - timestamp % RESPONSES_REFRESH_GRANULARITY_MS;
};

export const responsesStateCutoff = (evaluatedAt: number, retentionSeconds: number): number => {
  if (!isResponsesRetentionSeconds(retentionSeconds) || retentionSeconds === 0) {
    throw new RangeError(
      `Responses retention must be a whole-day integer from ${RESPONSES_RETENTION_MIN_SECONDS} to ${RESPONSES_RETENTION_MAX_SECONDS} seconds`,
    );
  }
  // Stored refresh times are floored to UTC day boundaries. Extending the
  // cutoff by that same bucket prevents quantization from expiring state
  // before its exact last access plus the configured retention.
  return evaluatedAt - retentionSeconds * 1000 - RESPONSES_REFRESH_GRANULARITY_MS;
};
