import { test } from 'vitest';

import { withClaudeAgentHeadersSet } from '../../../src/interceptors/anthropic-messages/set-claude-agent-headers.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {})(), testTelemetryModelIdentity));

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

const basePayload = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

test('Claude agent headers absent when session_id is missing', async () => {
  const ctx = invocation(basePayload(JSON.stringify({ device_id: 'dev-1' })));

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
