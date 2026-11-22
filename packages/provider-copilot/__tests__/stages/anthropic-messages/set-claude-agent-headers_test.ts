import { test } from 'vitest';

import { copilotClaudeAgentHeaderOverrides } from '../../../src/stages/anthropic-messages/set-claude-agent-headers.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const basePayload = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'hi' }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
});

test('Claude agent headers absent when session_id is missing', () => {
  assertEquals(copilotClaudeAgentHeaderOverrides(basePayload(JSON.stringify({ device_id: 'dev-1' }))), null);
});

test('Claude agent headers skipped on claude-opus-4-8 even with full fingerprint', () => {
  assertEquals(copilotClaudeAgentHeaderOverrides({ ...basePayload(JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' })), model: 'claude-opus-4-8' }), null);
});
