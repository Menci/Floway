import { test } from 'vitest';

import { anthropicMessagesStages } from '../../../src/stages/anthropic-messages/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Known SHA-256 → UUID v4 vectors, computed once by hand and stored here so
// any drift in the hashing or UUID-formatting logic surfaces as a clear
// regression. Format follows caozhiyuan's `getUUID`:
// https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L230
const SESS_ALONE_UUID = '19be0c9e-9a65-43eb-be80-efb2770d4510';

test('Interaction-id forwarded as a SHA-256 UUID even when only the sessionId half is parseable', async () => {
  const payload = {
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: JSON.stringify({ session_id: 'sess-alone' }) },
  };
  const { headers } = await inspectRequestStage(anthropicMessagesStages, 'set-interaction-id-header', payload);
  assertEquals(headers.get('x-interaction-id'), SESS_ALONE_UUID);
});
