import { test } from 'vitest';

import { setClaudeAgentHeaders } from '../../../src/pipelines/anthropic-messages/set-claude-agent-headers.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: AnthropicMessagesPayload): StageRequest<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
});

const basePayload = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

test('Claude agent headers absent when session_id is missing', async () => {
  const request = requestFor(basePayload(JSON.stringify({ device_id: 'dev-1' })));

  const result = await runStage(setClaudeAgentHeaders, 'anthropicMessages', request);

  assertEquals(result.headers.has('user-agent'), false);
  assertEquals(result.headers.has('copilot-integration-id'), false);
});

test('Claude agent headers skipped on claude-opus-4-8 even with full fingerprint', async () => {
  const request = requestFor({ ...basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })), model: 'claude-opus-4-8' });

  const result = await runStage(setClaudeAgentHeaders, 'anthropicMessages', request);

  assertEquals(result.headers.has('user-agent'), false);
  assertEquals(result.headers.has('openai-intent'), false);
  assertEquals(result.headers.has('x-interaction-type'), false);
  assertEquals(result.headers.has('copilot-integration-id'), false);
});
