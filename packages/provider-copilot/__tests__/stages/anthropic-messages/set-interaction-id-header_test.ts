import { test } from 'vitest';

import { copilotSessionUuid } from '../../../src/stages/anthropic-messages/set-interaction-id-header.ts';
import { assertEquals } from '@floway-dev/test-utils';

// Known SHA-256 → UUID v4 vectors, computed once by hand and stored here so
// any drift in the hashing or UUID-formatting logic surfaces as a clear
// regression. Format follows caozhiyuan's `getUUID`:
// https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L230
const SESS_ALONE_UUID = '19be0c9e-9a65-43eb-be80-efb2770d4510';

test('Interaction-id forwarded as a SHA-256 UUID even when only the sessionId half is parseable', async () => {
  assertEquals(await copilotSessionUuid('sess-alone'), SESS_ALONE_UUID);
});
