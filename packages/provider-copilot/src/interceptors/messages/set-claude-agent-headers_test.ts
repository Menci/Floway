import { test } from 'vitest';

import { withClaudeAgentHeadersSet } from './set-claude-agent-headers.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import { CLAUDE_AGENT_USER_AGENT } from '../../auth.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
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

  assertEquals(ctx.headers.get('x-interaction-type'), 'messages-proxy');
  assertEquals(ctx.headers.get('openai-intent'), 'messages-proxy');
  assertEquals(ctx.headers.get('user-agent'), CLAUDE_AGENT_USER_AGENT);
  // Empty-string sentinel: copilotFetch deletes the base copilot-integration-id.
  assertEquals(ctx.headers.get('copilot-integration-id'), '');
});

test('Claude agent headers set for the JSON fingerprint with device_id + session_id', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('user-agent'), CLAUDE_AGENT_USER_AGENT);
  assertEquals(ctx.headers.get('copilot-integration-id'), '');
});

test('Claude agent headers absent when session_id is missing', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ device_id: 'dev-1' })));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('user-agent'), false);
  assertEquals(ctx.headers.has('copilot-integration-id'), false);
});

test('Claude agent headers absent when safety identifier is missing', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ session_id: 'sess-only' })));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('user-agent'), false);
  assertEquals(ctx.headers.has('copilot-integration-id'), false);
});

test('Claude agent headers absent when metadata is not provided', async () => {
  const ctx = invocation(basePayload(undefined));

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('user-agent'), false);
  assertEquals(ctx.headers.has('copilot-integration-id'), false);
});

test('Claude agent headers skipped on claude-opus-4-8 even with full fingerprint', async () => {
  const ctx = invocation({ ...basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })), model: 'claude-opus-4-8' });

  await withClaudeAgentHeadersSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('user-agent'), false);
  assertEquals(ctx.headers.has('openai-intent'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
  assertEquals(ctx.headers.has('copilot-integration-id'), false);
});
