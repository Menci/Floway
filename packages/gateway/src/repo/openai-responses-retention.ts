import { MILLISECONDS_PER_DAY, RETENTION_MAX_SECONDS, SECONDS_PER_DAY } from '../shared/retention.ts';

export const OPENAI_RESPONSES_REFRESH_GRANULARITY_MS = MILLISECONDS_PER_DAY;
export const OPENAI_RESPONSES_RETENTION_MIN_SECONDS = SECONDS_PER_DAY;
export const OPENAI_RESPONSES_RETENTION_MAX_SECONDS = RETENTION_MAX_SECONDS;

export const isOpenAIResponsesRetentionSeconds = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && (
    value === 0
    || (
      value >= OPENAI_RESPONSES_RETENTION_MIN_SECONDS
      && value <= OPENAI_RESPONSES_RETENTION_MAX_SECONDS
      && value % SECONDS_PER_DAY === 0
    )
  );

export const quantizeOpenAIResponsesRefreshedAt = (timestamp: number): number => {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError('OpenAI Responses refresh timestamp must be a non-negative safe integer');
  }
  return timestamp - timestamp % OPENAI_RESPONSES_REFRESH_GRANULARITY_MS;
};

export const openaiResponsesStateCutoff = (evaluatedAt: number, retentionSeconds: number): number => {
  if (!isOpenAIResponsesRetentionSeconds(retentionSeconds) || retentionSeconds === 0) {
    throw new RangeError(
      `OpenAI Responses retention must be a whole-day integer from ${OPENAI_RESPONSES_RETENTION_MIN_SECONDS} to ${OPENAI_RESPONSES_RETENTION_MAX_SECONDS} seconds`,
    );
  }
  // Stored refresh times are floored to UTC day boundaries. Extending the
  // cutoff by that same bucket prevents quantization from expiring state
  // before its exact last access plus the configured retention.
  return evaluatedAt - retentionSeconds * 1000 - OPENAI_RESPONSES_REFRESH_GRANULARITY_MS;
};
