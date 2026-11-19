import { describe, expect, test } from 'vitest';

import {
  isOpenAIResponsesRetentionSeconds,
  OPENAI_RESPONSES_REFRESH_GRANULARITY_MS,
  OPENAI_RESPONSES_RETENTION_MAX_SECONDS,
  openaiResponsesStateCutoff,
} from '../../src/repo/openai-responses-retention.ts';
import { SECONDS_PER_DAY } from '../../src/shared/retention.ts';

describe('OpenAI Responses retention', () => {
  test('accepts disabled or whole-day retention only', () => {
    expect(isOpenAIResponsesRetentionSeconds(0)).toBe(true);
    expect(isOpenAIResponsesRetentionSeconds(SECONDS_PER_DAY)).toBe(true);
    expect(isOpenAIResponsesRetentionSeconds(OPENAI_RESPONSES_RETENTION_MAX_SECONDS)).toBe(true);
    expect(isOpenAIResponsesRetentionSeconds(60 * 60)).toBe(false);
    expect(isOpenAIResponsesRetentionSeconds(SECONDS_PER_DAY + 1)).toBe(false);
    expect(isOpenAIResponsesRetentionSeconds(OPENAI_RESPONSES_RETENTION_MAX_SECONDS + SECONDS_PER_DAY)).toBe(false);
  });

  test('gives quantized state one fixed day of expiration grace', () => {
    const now = Date.UTC(2026, 6, 24, 12);
    expect(openaiResponsesStateCutoff(now, 7 * SECONDS_PER_DAY))
      .toBe(now - 8 * OPENAI_RESPONSES_REFRESH_GRANULARITY_MS);
  });
});
