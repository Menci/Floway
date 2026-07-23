export const RESPONSES_RETENTION_MIN_SECONDS = 60 * 60;
export const RESPONSES_RETENTION_MAX_SECONDS = 10 * 365 * 24 * 60 * 60;

export const responsesStateCutoff = (activeAt: number, retentionSeconds: number): number => {
  if (
    !Number.isSafeInteger(retentionSeconds)
    || retentionSeconds < RESPONSES_RETENTION_MIN_SECONDS
    || retentionSeconds > RESPONSES_RETENTION_MAX_SECONDS
  ) {
    throw new RangeError(
      `Responses retention must be an integer from ${RESPONSES_RETENTION_MIN_SECONDS} to ${RESPONSES_RETENTION_MAX_SECONDS} seconds`,
    );
  }
  return activeAt - retentionSeconds * 1000;
};
