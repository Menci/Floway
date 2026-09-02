import type { ApiKey } from '../../../../src/repo/types.ts';

export const TEST_OPENAI_RESPONSES_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const testOpenAIResponsesStatePolicy = (
  id = 'key-a',
): Pick<ApiKey, 'id' | 'openaiResponsesRetentionSeconds'> => ({
  id,
  openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
});
