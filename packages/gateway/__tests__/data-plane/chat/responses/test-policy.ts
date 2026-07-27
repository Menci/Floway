import type { ApiKey } from '../../../../src/repo/types.ts';

export const TEST_RESPONSES_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const testResponsesStatePolicy = (
  id = 'key-a',
): Pick<ApiKey, 'id' | 'responsesRetentionSeconds'> => ({
  id,
  responsesRetentionSeconds: TEST_RESPONSES_RETENTION_SECONDS,
});
