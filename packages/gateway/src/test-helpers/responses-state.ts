import type { ResponsesStatePolicy } from '../data-plane/chat/responses/items/store.ts';
import { responsesStateLifetime } from '../repo/responses-retention.ts';

export const TEST_RESPONSES_STATE_EPOCH = '11'.repeat(16);
export const TEST_RESPONSES_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const testResponsesStatePolicy = (
  apiKeyId: string,
  retentionSeconds = TEST_RESPONSES_RETENTION_SECONDS,
): ResponsesStatePolicy => ({
  apiKeyId,
  stateEpoch: TEST_RESPONSES_STATE_EPOCH,
  retentionSeconds,
});

export const testResponsesStateLifetime = (refreshedAt: number) =>
  responsesStateLifetime(refreshedAt, TEST_RESPONSES_RETENTION_SECONDS);
