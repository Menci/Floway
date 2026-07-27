import { describe, expect, test } from 'vitest';

import {
  isResponsesRetentionSeconds,
  quantizeResponsesRefreshedAt,
  RESPONSES_REFRESH_GRANULARITY_MS,
  RESPONSES_RETENTION_MAX_SECONDS,
  responsesStateCutoff,
} from '../../src/repo/responses-retention.ts';
import { SECONDS_PER_DAY } from '../../src/shared/retention.ts';

describe('Responses retention', () => {
  test('accepts disabled or whole-day retention only', () => {
    expect(isResponsesRetentionSeconds(0)).toBe(true);
    expect(isResponsesRetentionSeconds(SECONDS_PER_DAY)).toBe(true);
    expect(isResponsesRetentionSeconds(RESPONSES_RETENTION_MAX_SECONDS)).toBe(true);
    expect(isResponsesRetentionSeconds(60 * 60)).toBe(false);
    expect(isResponsesRetentionSeconds(SECONDS_PER_DAY + 1)).toBe(false);
    expect(isResponsesRetentionSeconds(RESPONSES_RETENTION_MAX_SECONDS + SECONDS_PER_DAY)).toBe(false);
  });

  test('quantizes refresh timestamps to the start of their UTC day', () => {
    const dayStart = Date.UTC(2026, 6, 24);
    expect(quantizeResponsesRefreshedAt(dayStart)).toBe(dayStart);
    expect(quantizeResponsesRefreshedAt(dayStart + RESPONSES_REFRESH_GRANULARITY_MS - 1)).toBe(dayStart);
  });

  test('gives quantized state one fixed day of expiration grace', () => {
    const now = Date.UTC(2026, 6, 24, 12);
    expect(responsesStateCutoff(now, 7 * SECONDS_PER_DAY))
      .toBe(now - 8 * RESPONSES_REFRESH_GRANULARITY_MS);
  });
});
