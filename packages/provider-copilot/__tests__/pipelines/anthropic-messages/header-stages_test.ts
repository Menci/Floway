import { expect, test } from 'vitest';

import { CLAUDE_AGENT_USER_AGENT } from '../../../src/auth.ts';
import { setClaudeAgentHeaders } from '../../../src/pipelines/anthropic-messages/set-claude-agent-headers.ts';
import { setCompactHeaders } from '../../../src/pipelines/anthropic-messages/set-compact-headers.ts';
import { setInitiatorHeader } from '../../../src/pipelines/anthropic-messages/set-initiator-header.ts';
import { setInteractionIdHeader } from '../../../src/pipelines/anthropic-messages/set-interaction-id-header.ts';
import { setIdentityHeaders } from '../../../src/pipelines/shared/set-identity-headers.ts';
import { runStage } from '../stage.ts';

const COMPACT_LAST_MESSAGE_TEXT =
  'Your task is to create a detailed summary of the conversation so far.\n\n' +
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
  'Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff';

test('Claude Code SDK attribution prevails on Copilot compaction', async () => {
  const result = await runStage([
    setIdentityHeaders,
    setCompactHeaders,
    setClaudeAgentHeaders,
    setInteractionIdHeader,
    setInitiatorHeader,
  ], 'anthropicMessages', {
    payload: {
      model: 'claude-test',
      max_tokens: 10,
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
      messages: [{ role: 'user', content: COMPACT_LAST_MESSAGE_TEXT }],
    },
  });
  expect(result.headers.get('x-initiator')).toBe('user');
  expect(result.headers.get('x-interaction-type')).toBe('messages-proxy');
  expect(result.headers.get('openai-intent')).toBe('messages-proxy');
  expect(result.headers.get('user-agent')).toBe(CLAUDE_AGENT_USER_AGENT);
  expect(result.headers.get('copilot-integration-id')).toBeNull();
  expect(result.headers.get('x-interaction-id')).toBe('abe633f3-a47a-4758-974e-abe9160daf36');
});
