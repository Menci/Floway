import { test } from 'vitest';

import { messagesCopilotSourceInterceptors } from './index.ts';
import { CLAUDE_AGENT_USER_AGENT } from '../../../../../shared/copilot.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import { runInterceptors, type MessagesInvocation, type RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
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

  await runInterceptors<MessagesInvocation, RequestContext, ExecuteResult<ProtocolFrame<MessagesStreamEvent>>>(
    ctx,
    stubRequest,
    messagesCopilotSourceInterceptors,
    okEvents,
  );

  // Compact set `x-initiator: agent`; Claude-agent does not touch it.
  assertEquals(ctx.headers['x-initiator'], 'agent');
  // Compact set `conversation-compaction`; Claude-agent's `messages-proxy`
  // runs after and overrides it. This mirrors caozhiyuan/copilot-api's
  // prepareForCompact → prepareMessageProxyHeaders order.
  assertEquals(ctx.headers['x-interaction-type'], 'messages-proxy');
  assertEquals(ctx.headers['openai-intent'], 'messages-proxy');
  assertEquals(ctx.headers['user-agent'], CLAUDE_AGENT_USER_AGENT);
  // Empty-string sentinel: copilotFetch will delete the base header.
  assertEquals(ctx.headers['copilot-integration-id'], '');
  // SHA-256-then-UUIDv4 of 'sess-1' (matches caozhiyuan's getUUID).
  assertEquals(ctx.headers['x-interaction-id'], 'abe633f3-a47a-4758-974e-abe9160daf36');
});
