import { test } from 'vitest';

import { anthropicMessagesStages } from '../../../src/stages/anthropic-messages/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const basePayload = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

test('Claude agent headers absent when session_id is missing', async () => {
  const payload = basePayload(JSON.stringify({ device_id: 'dev-1' }));
  const { headers } = await inspectRequestStage(anthropicMessagesStages, 'set-claude-agent-headers', payload);
  assertEquals(headers.has('user-agent'), false);
  assertEquals(headers.has('copilot-integration-id'), false);
});

test('Claude agent headers skipped on claude-opus-4-8 even with full fingerprint', async () => {
  const payload = { ...basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })), model: 'claude-opus-4-8' };
  const { headers } = await inspectRequestStage(anthropicMessagesStages, 'set-claude-agent-headers', payload);
  assertEquals(headers.has('user-agent'), false);
  assertEquals(headers.has('openai-intent'), false);
  assertEquals(headers.has('x-interaction-type'), false);
  assertEquals(headers.has('copilot-integration-id'), false);
});
