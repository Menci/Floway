import { test } from 'vitest';

import { withClaudeAgentHeadersSet } from './set-claude-agent-headers.ts';
import { CLAUDE_AGENT_USER_AGENT } from '../../../../../shared/copilot.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
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

const basePayload = (userId: string | undefined): MessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

test('Claude agent headers set for the legacy fingerprint with both halves', async () => {
  const ctx = invocation(basePayload('user_acct-1_account__session_sess-1'));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-interaction-type'], 'messages-proxy');
  assertEquals(ctx.headers['openai-intent'], 'messages-proxy');
  assertEquals(ctx.headers['user-agent'], CLAUDE_AGENT_USER_AGENT);
  // Empty-string sentinel: copilotFetch deletes the base copilot-integration-id.
  assertEquals(ctx.headers['copilot-integration-id'], '');
});

test('Claude agent headers set for the JSON fingerprint with device_id + session_id', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['user-agent'], CLAUDE_AGENT_USER_AGENT);
  assertEquals(ctx.headers['copilot-integration-id'], '');
});

test('Claude agent headers absent when session_id is missing', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ device_id: 'dev-1' })));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals('user-agent' in ctx.headers, false);
  assertEquals('copilot-integration-id' in ctx.headers, false);
});

test('Claude agent headers absent when safety identifier is missing', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ session_id: 'sess-only' })));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals('user-agent' in ctx.headers, false);
  assertEquals('copilot-integration-id' in ctx.headers, false);
});

test('Claude agent headers absent when metadata is not provided', async () => {
  const ctx = invocation(basePayload(undefined));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals('user-agent' in ctx.headers, false);
  assertEquals('copilot-integration-id' in ctx.headers, false);
});

test('Claude agent headers skipped on claude-opus-4-8 even with full fingerprint', async () => {
  const ctx = invocation({ ...basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })), model: 'claude-opus-4-8' });

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals('user-agent' in ctx.headers, false);
  assertEquals('openai-intent' in ctx.headers, false);
  assertEquals('x-interaction-type' in ctx.headers, false);
  assertEquals('copilot-integration-id' in ctx.headers, false);
});
