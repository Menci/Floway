import { test } from 'vitest';

import { withInteractionIdHeaderSet } from '../../../src/interceptors/anthropic-messages/set-interaction-id-header.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { ExecuteResult } from '@floway-dev/upstream';
import { eventResult } from '@floway-dev/upstream';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {})(), testTelemetryModelIdentity));

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesBoundaryCtx => ({
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
  const ctx = invocation(payloadWith(JSON.stringify({ session_id: 'sess-alone' })));

  await withInteractionIdHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('x-interaction-id'), SESS_ALONE_UUID);
});
