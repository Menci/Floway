import { test } from 'vitest';

import { setClaudeAgentHeaders } from '../../../src/pipelines/anthropic-messages/set-claude-agent-headers.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ id: payload.model, endpoints: { anthropicMessages: {} } }),
});

const basePayload = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

test('Claude agent headers absent when session_id is missing', async () => {
  const fixture = invocation(basePayload(JSON.stringify({ device_id: 'dev-1' })));

  const ctx = await inspectStages('anthropicMessages', setClaudeAgentHeaders, fixture);

  assertEquals(ctx.headers.has('user-agent'), false);
  assertEquals(ctx.headers.has('copilot-integration-id'), false);
});

test('Claude agent headers skipped on claude-opus-4-8 even with full fingerprint', async () => {
  const fixture = invocation({ ...basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })), model: 'claude-opus-4-8' });

  const ctx = await inspectStages('anthropicMessages', setClaudeAgentHeaders, fixture);

  assertEquals(ctx.headers.has('user-agent'), false);
  assertEquals(ctx.headers.has('openai-intent'), false);
  assertEquals(ctx.headers.has('x-interaction-type'), false);
  assertEquals(ctx.headers.has('copilot-integration-id'), false);
});
