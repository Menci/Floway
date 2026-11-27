import { test } from 'vitest';

import { CLAUDE_AGENT_USER_AGENT } from '../../../src/auth.ts';
import { setClaudeAgentHeaders } from '../../../src/pipelines/anthropic-messages/set-claude-agent-headers.ts';
import { setCompactHeaders } from '../../../src/pipelines/anthropic-messages/set-compact-headers.ts';
import { setInitiatorHeader } from '../../../src/pipelines/anthropic-messages/set-initiator-header.ts';
import { setInteractionIdHeader } from '../../../src/pipelines/anthropic-messages/set-interaction-id-header.ts';
import { setIdentityHeaders } from '../../../src/pipelines/shared/set-identity-headers.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubUpstreamModel({ endpoints: { anthropicMessages: {} } }),
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
  // stage — matching what VSCode Copilot Chat sends for the same call.
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
    messages: [{ role: 'user', content: COMPACT_LAST_MESSAGE_TEXT }],
  });

  const ctx = await inspectStages('anthropicMessages', [
    setIdentityHeaders,
    setCompactHeaders,
    setClaudeAgentHeaders,
    setInteractionIdHeader,
    setInitiatorHeader,
  ], fixture);

  // The final initiator stage classifies the last wire message.
  assertEquals(ctx.headers.get('x-initiator'), 'user');
  // Compact set `conversation-compaction`; Claude-agent's `messages-proxy`
  // runs after and overrides it. This mirrors caozhiyuan/copilot-api's
  // prepareForCompact → prepareMessageProxyHeaders order.
  assertEquals(ctx.headers.get('x-interaction-type'), 'messages-proxy');
  assertEquals(ctx.headers.get('openai-intent'), 'messages-proxy');
  assertEquals(ctx.headers.get('user-agent'), CLAUDE_AGENT_USER_AGENT);
  assertEquals(ctx.headers.get('copilot-integration-id'), null);
  // SHA-256-then-UUIDv4 of 'sess-1' (matches caozhiyuan's getUUID).
  assertEquals(ctx.headers.get('x-interaction-id'), 'abe633f3-a47a-4758-974e-abe9160daf36');
});
