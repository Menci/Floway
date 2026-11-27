import { test } from 'vitest';

import { setInteractionIdHeader } from '../../../src/pipelines/anthropic-messages/set-interaction-id-header.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubUpstreamModel({ endpoints: { anthropicMessages: {} } }),
});

const payloadWith = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

// Known SHA-256 → UUID v4 vectors, computed once by hand and stored here so
// any drift in the hashing or UUID-formatting logic surfaces as a clear
// regression. Format follows caozhiyuan's `getUUID`:
// https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/utils.ts#L230
const SESS_ALONE_UUID = '19be0c9e-9a65-43eb-be80-efb2770d4510';

test('Interaction-id forwarded as a SHA-256 UUID even when only the sessionId half is parseable', async () => {
  // OpenCode-like payloads sometimes ship session_id without a paired
  // device_id / account_uuid; we still want trace correlation in that case.
  const fixture = invocation(payloadWith(JSON.stringify({ session_id: 'sess-alone' })));

  const ctx = await inspectStages('anthropicMessages', setInteractionIdHeader, fixture);

  assertEquals(ctx.headers.get('x-interaction-id'), SESS_ALONE_UUID);
});
