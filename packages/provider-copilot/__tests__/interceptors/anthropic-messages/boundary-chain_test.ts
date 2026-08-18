import { test } from 'vitest';

import { CLAUDE_AGENT_USER_AGENT } from '../../../src/auth.ts';
import { COPILOT_ANTHROPIC_MESSAGES_BOUNDARY } from '../../../src/interceptors/anthropic-messages/index.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const COMPACT_LAST_MESSAGE_TEXT =
  'Your task is to create a detailed summary of the conversation so far.\n\n' +
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
  'Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff';

test('Claude Code SDK compact request: Claude-agent overrides compact intent, both halves of metadata threaded through', async () => {
  // This is the realistic ordering case: a Claude Code compact summary call
  // ALSO carries the Claude Code SDK fingerprint. We expect the final wire
  // headers to be `messages-proxy` (Claude-agent wins over compact's
  // `conversation-compaction`), the user-agent and integration-id deletion
  // from Claude-agent, and an `x-interaction-id` from the interaction-id
  // interceptor — matching what VSCode Copilot Chat sends for the same call.
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
    messages: [{ role: 'user', content: COMPACT_LAST_MESSAGE_TEXT }],
  });

  await runInterceptors<AnthropicMessagesBoundaryCtx, object, ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>>(
    ctx,
    stubRequest,
    COPILOT_ANTHROPIC_MESSAGES_BOUNDARY,
    okEvents,
  );

  // Compact set `x-initiator: agent` early; `withInitiatorHeaderSet` runs
  // later in the merged boundary chain and re-derives x-initiator from the
  // last-message structure, so the final wire value reflects the wire-shape
  // pass. (That is the same value the pre-merge production code shipped,
  // because the target chain always overrode the source-side tag.)
  assertEquals(ctx.headers.get('x-initiator'), 'user');
  // Compact set `conversation-compaction`; Claude-agent's `messages-proxy`
  // runs after and overrides it. This mirrors caozhiyuan/copilot-api's
  // prepareForCompact → prepareMessageProxyHeaders order.
  assertEquals(ctx.headers.get('x-interaction-type'), 'messages-proxy');
  assertEquals(ctx.headers.get('openai-intent'), 'messages-proxy');
  assertEquals(ctx.headers.get('user-agent'), CLAUDE_AGENT_USER_AGENT);
  // Empty-string sentinel: `copilotAuthedFetch` in
  // `packages/provider-copilot/src/auth.ts` deletes the base header.
  assertEquals(ctx.headers.get('copilot-integration-id'), '');
  // SHA-256-then-UUIDv4 of 'sess-1' (matches caozhiyuan's getUUID).
  assertEquals(ctx.headers.get('x-interaction-id'), 'abe633f3-a47a-4758-974e-abe9160daf36');
});
